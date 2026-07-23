#!/usr/bin/env node

// src/socket-worker.mjs
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { readFileSync, appendFileSync } from "fs";
import * as https from "https";
var LOG_FILE = "/tmp/slack-agent-plugin.log";
var log = (m) => {
  try {
    appendFileSync(LOG_FILE, `[${(/* @__PURE__ */ new Date()).toISOString()}] worker: ${m}
`);
  } catch {
  }
};
var SLACK_MSG_LIMIT = 3900;
var botToken = process.env.SLACK_BOT_TOKEN;
var appToken = process.env.SLACK_APP_TOKEN;
var caCerts = process.env.NODE_EXTRA_CA_CERTS;
if (!botToken || !appToken) {
  process.exit(1);
}
var agent;
if (caCerts) {
  try {
    const ca = readFileSync(caCerts);
    agent = new https.Agent({ ca });
  } catch {
  }
}
var slack = new WebClient(botToken, agent ? { agent, tls: { ca: agent.options.ca } } : void 0);
var socketClient = new SocketModeClient({ appToken });
var botUserId;
var EVENT_DEDUPE_TTL_MS = 10 * 60 * 1e3;
var seenEventKeys = /* @__PURE__ */ new Map();
function formatInboundMeta(body, ev) {
  const eventId = typeof body?.event_id === "string" ? body.event_id : "-";
  const eventType = typeof ev?.type === "string" ? ev.type : "-";
  const channel = typeof ev?.channel === "string" ? ev.channel : "-";
  const ts = typeof ev?.ts === "string" ? ev.ts : "-";
  const threadTs = typeof ev?.thread_ts === "string" ? ev.thread_ts : "-";
  const user = typeof ev?.user === "string" ? ev.user : "-";
  return `event_id=${eventId} type=${eventType} channel=${channel} ts=${ts} thread_ts=${threadTs} user=${user}`;
}
function buildEventKey(body, ev) {
  const channel = typeof ev?.channel === "string" ? ev.channel : "";
  const ts = typeof ev?.ts === "string" ? ev.ts : "";
  if (channel && ts) return `msg:${channel}:${ts}`;
  const eventId = typeof body?.event_id === "string" ? body.event_id : "";
  if (eventId) return `event:${eventId}`;
  return "";
}
function shouldProcessEvent(eventKey) {
  if (!eventKey) return true;
  const now = Date.now();
  for (const [key, expiresAt] of seenEventKeys) {
    if (expiresAt <= now) seenEventKeys.delete(key);
  }
  if (seenEventKeys.has(eventKey)) return false;
  seenEventKeys.set(eventKey, now + EVENT_DEDUPE_TTL_MS);
  return true;
}
async function init() {
  const auth = await slack.auth.test();
  botUserId = auth.user_id;
  log(`ready: bot=${botUserId}`);
}
async function sendToSlack(channel, text, threadTs) {
  try {
    if (text.length <= SLACK_MSG_LIMIT) {
      await slack.chat.postMessage({ channel, text, thread_ts: threadTs, mrkdwn: true });
      return;
    }
    const chunks = [];
    const lines = text.split("\n");
    let current = "";
    for (const line of lines) {
      if (current.length + line.length + 1 > SLACK_MSG_LIMIT) {
        chunks.push(current);
        current = line;
      } else {
        current = current ? current + "\n" + line : line;
      }
    }
    if (current) chunks.push(current);
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `_(${i + 1}/${chunks.length})_
` : "";
      await slack.chat.postMessage({
        channel,
        text: prefix + chunks[i],
        thread_ts: threadTs || void 0,
        mrkdwn: true
      });
    }
  } catch {
  }
}
async function addReaction(channel, name, timestamp) {
  try {
    await slack.reactions.add({ channel, name, timestamp });
  } catch {
  }
}
process.on("message", async (msg) => {
  if (msg?.type === "slack_send") {
    await sendToSlack(msg.channel, msg.text, msg.threadTs);
  } else if (msg?.type === "slack_update") {
    try {
      await slack.chat.update({ channel: msg.channel, ts: msg.ts, text: msg.text, mrkdwn: true });
    } catch {
    }
  } else if (msg?.type === "slack_reaction") {
    await addReaction(msg.channel, msg.name, msg.timestamp);
  } else if (msg?.type === "slack_reaction_remove") {
    try {
      await slack.reactions.remove({ channel: msg.channel, name: msg.name, timestamp: msg.timestamp });
    } catch {
    }
  } else if (msg?.type === "slack_upload") {
    try {
      await slack.filesUploadV2({
        channel_id: msg.channel,
        thread_ts: msg.threadTs,
        content: msg.content,
        filename: msg.filename || "response.md",
        title: msg.title || "Response"
      });
    } catch (e) {
      log(`upload error: ${e.message}`);
      await sendToSlack(msg.channel, msg.content, msg.threadTs);
    }
  } else if (msg?.type === "resolve_emails") {
    const resolved = [];
    for (const email of msg.emails || []) {
      try {
        const result = await slack.users.lookupByEmail({ email });
        if (result?.user?.id) resolved.push(result.user.id);
      } catch {
      }
    }
    if (resolved.length > 0 && process.send) {
      process.send({ type: "resolved_emails", users: resolved });
    }
  }
});
socketClient.on("slack_event", async ({ body, ack }) => {
  const ev = body?.event;
  log(`ingress received ${formatInboundMeta(body, ev)}`);
  if (ack) {
    try {
      await ack();
      log(`ingress ack sent ${formatInboundMeta(body, ev)}`);
    } catch (e) {
      log(`ingress ack failed ${formatInboundMeta(body, ev)} err=${e?.message || String(e)}`);
    }
  }
  if (!ev) return;
  const eventKey = buildEventKey(body, ev);
  if (!shouldProcessEvent(eventKey)) {
    log(`ingress duplicate skipped key=${eventKey} ${formatInboundMeta(body, ev)}`);
    return;
  }
  if (ev.type === "message" || ev.type === "app_mention") {
    if (ev.bot_id || ev.user === botUserId) {
      log(`ingress dropped reason=self_or_bot ${formatInboundMeta(body, ev)}`);
      return;
    }
    if (ev.subtype && ev.subtype !== "file_share") {
      log(`ingress dropped reason=subtype_${ev.subtype} ${formatInboundMeta(body, ev)}`);
      return;
    }
    if (!ev.channel || !ev.text || !ev.ts) {
      log(`ingress dropped reason=missing_required_fields ${formatInboundMeta(body, ev)}`);
      return;
    }
    const text = ev.type === "app_mention" ? ev.text.replace(/<@[A-Z0-9]+>/g, "").trim() : ev.text;
    if (text && process.send) {
      process.send({
        type: "slack_event",
        channel: ev.channel,
        text,
        ts: ev.ts,
        threadTs: ev.thread_ts || ev.ts,
        messageTs: ev.ts,
        eventId: typeof body?.event_id === "string" ? body.event_id : void 0,
        user: ev.user,
        eventSubtype: ev.type
      });
      log(`ingress forwarded_to_plugin key=${eventKey || "-"} ${formatInboundMeta(body, ev)} text_preview=${text.slice(0, 50)}`);
    }
  }
});
var RECONNECT_GRACE_MS = 6e4;
var outageStartedAt = null;
socketClient.on("connected", () => {
  outageStartedAt = null;
  log("Socket Mode connected");
  if (process.send) process.send({ type: "worker_connected" });
});
socketClient.on("disconnected", () => {
  if (!outageStartedAt) outageStartedAt = Date.now();
  log("Socket Mode disconnected \u2014 waiting for SDK auto-reconnect");
});
socketClient.on("reconnecting", () => {
  if (!outageStartedAt) outageStartedAt = Date.now();
  log("Socket Mode reconnecting...");
});
await init();
await socketClient.start();
log("worker running (idle-exit disabled, relying on SDK ping/pong health check)");
setInterval(() => {
  if (outageStartedAt) {
    const elapsed = Date.now() - outageStartedAt;
    if (elapsed > RECONNECT_GRACE_MS) {
      log(`connection unhealthy for ${Math.round(elapsed / 1e3)}s with no reconnect \u2014 exiting for restart`);
      process.exit(1);
    }
  }
}, 15e3);
