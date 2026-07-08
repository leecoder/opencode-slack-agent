import type { PluginModule, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { spawn, type ChildProcess } from "child_process";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const LOG_FILE = "/tmp/slack-agent-plugin.log";
const SLACK_MSG_LIMIT = 3900;
const RESPONSE_STALL_MS = 45_000;
const RESPONSE_STALL_NOTIFY_INTERVAL_MS = 60_000;

let initialized = false;
let worker: ChildProcess | null = null;
let pluginClient: PluginInput["client"] | null = null;
let modelOverride: { providerID: string; modelID: string } | null = null;
let agentOverride: string | null = null;
let sessionsPath: string = "";
let sessions: Record<string, { sessionId: string; channel: string; lastUsed: number; directory?: string }> = {};
let defaultDirectory: string = "";
let allowedUsers: Set<string> | null = null;
let allowlistReady = true;

type PendingPermission = {
  permissionId: string;
  sessionId: string;
  threadTs: string;
  channel: string;
  createdAt: number;
};
let pendingPermissions: Map<string, PendingPermission> = new Map();

type PendingQuestion = {
  sessionId: string;
  threadTs: string;
  channel: string;
  createdAt: number;
};
let pendingQuestions: Map<string, PendingQuestion> = new Map();

function log(m: string) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] plugin: ${m}\n`); } catch {}
}

function loadSessions() {
  try {
    if (existsSync(sessionsPath)) {
      sessions = JSON.parse(readFileSync(sessionsPath, "utf8"));
    }
  } catch { sessions = {}; }
}

function saveSessions() {
  try { writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2)); } catch {}
}

function getSessionForThread(threadTs: string): string | null {
  const entry = sessions[threadTs];
  if (entry) {
    entry.lastUsed = Date.now();
    saveSessions();
    return entry.sessionId;
  }
  return null;
}

function saveSession(threadTs: string, sessionId: string, channel: string, directory?: string) {
  sessions[threadTs] = { sessionId, channel, lastUsed: Date.now(), ...(directory ? { directory } : {}) };
  saveSessions();
}

function markdownToSlackMrkdwn(text: string): string {
  let result = text;
  const codeBlocks: string[] = [];
  result = result.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(code);
    return `\x00INLINE${inlineCodes.length - 1}\x00`;
  });
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
  result = result.replace(/\*\*+/g, "*");
  result = result.replace(/~~(.+?)~~/g, "~$1~");
  result = result.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  for (let i = 0; i < inlineCodes.length; i++) {
    result = result.replace(`\x00INLINE${i}\x00`, `\`${inlineCodes[i]}\``);
  }
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`\x00CODEBLOCK${i}\x00`, "```\n" + codeBlocks[i] + "```");
  }
  return result;
}

function sendIPC(msg: any) {
  if (worker && worker.connected) worker.send(msg);
}

function slackSend(channel: string, text: string, threadTs?: string) {
  sendIPC({ type: "slack_send", channel, text: markdownToSlackMrkdwn(text), threadTs });
}

function slackUpdate(channel: string, ts: string, text: string) {
  sendIPC({ type: "slack_update", channel, ts, text });
}

function findPendingPermissionForThread(threadTs: string): PendingPermission | null {
  for (const [key, perm] of pendingPermissions) {
    if (perm.threadTs === threadTs) {
      if (Date.now() - perm.createdAt > 5 * 60 * 1000) {
        pendingPermissions.delete(key);
        return null;
      }
      return perm;
    }
  }
  return null;
}

async function handlePermissionReply(pending: PendingPermission, text: string, channel: string, threadTs: string) {
  if (!pluginClient) return;
  const trimmed = text.trim().toLowerCase();
  let reply: "once" | "always" | "reject" | null = null;
  if (["1", "y", "yes", "once"].includes(trimmed)) reply = "once";
  else if (["2", "always"].includes(trimmed)) reply = "always";
  else if (["3", "n", "no", "reject"].includes(trimmed)) reply = "reject";

  if (!reply) {
    slackSend(channel, "_잘못된 응답. 1/y/yes, 2/always, 3/n/no 로 답해주세요._", threadTs);
    return;
  }

  try {
    await pluginClient.postSessionIdPermissionsPermissionId({
      path: { id: pending.sessionId, permissionID: pending.permissionId },
      body: { response: reply },
    });
    pendingPermissions.delete(pending.permissionId);
    const label = reply === "reject" ? "거부" : `허용 (${reply})`;
    slackSend(channel, `_권한 ${label}_`, threadTs);
    log(`permission ${pending.permissionId} replied: ${reply}`);
  } catch (e: any) {
    pendingPermissions.delete(pending.permissionId);
    slackSend(channel, `_권한 응답 실패: ${e.message}_`, threadTs);
    log(`permission reply error: ${e.message}`);
  }
}

function findPendingQuestionForThread(threadTs: string): PendingQuestion | null {
  for (const [key, q] of pendingQuestions) {
    if (q.threadTs === threadTs) {
      if (Date.now() - q.createdAt > 5 * 60 * 1000) {
        pendingQuestions.delete(key);
        return null;
      }
      return q;
    }
  }
  return null;
}

async function handleQuestionReply(pending: PendingQuestion, text: string, channel: string, threadTs: string) {
  if (!pluginClient) return;
  try {
    await pluginClient.tui.control.response({
      body: text.trim(),
    });
    pendingQuestions.delete(threadTs);
    log(`question replied: ${text.slice(0, 50)}`);
  } catch (e: any) {
    pendingQuestions.delete(threadTs);
    slackSend(channel, `_응답 전달 실패: ${e.message}_`, threadTs);
    log(`question reply error: ${e.message}`);
  }
}

async function handleMessage(channel: string, text: string, ts: string, messageTs?: string, isAllowed: boolean = true) {
  if (!pluginClient) return;
  const actualTs = messageTs || ts;
  log(`handleMessage: ${text.slice(0, 50)}`);

  if (text.startsWith("!")) {
    if (!isAllowed) return;
    const handled = await handleCommand(channel, text, ts);
    if (handled) return;
  }

  const pending = findPendingPermissionForThread(ts);
  if (pending) {
    if (!isAllowed) return;
    await handlePermissionReply(pending, text, channel, ts);
    return;
  }

  const pendingQ = findPendingQuestionForThread(ts);
  if (pendingQ) {
    await handleQuestionReply(pendingQ, text, channel, ts);
    return;
  }

  try {
    const threadTs = ts;
    let sessionId = getSessionForThread(threadTs);

    sendIPC({ type: "slack_reaction", channel, name: "peperun", timestamp: actualTs });

    if (!sessionId) {
      const directory = sessions[threadTs]?.directory || defaultDirectory;
      const { data: session } = await pluginClient.session.create({
        body: { title: `Slack: ${text.slice(0, 50)}` },
        query: directory ? { directory } : undefined,
      });
      if (!session?.id) {
        slackSend(channel, "❌ 세션 생성 실패", threadTs);
        return;
      }
      sessionId = session.id;
      saveSession(threadTs, sessionId, channel, directory);
      log(`new session: ${sessionId} for thread ${threadTs} (dir: ${directory || "default"})`);
    } else {
      log(`existing session: ${sessionId} for thread ${threadTs}`);
    }

    let promptText = text;
    let promptAgent = agentOverride;
    const agentMatch = text.match(/^@(\S+)\s+([\s\S]*)$/);
    if (agentMatch) {
      promptAgent = agentMatch[1];
      promptText = agentMatch[2].trim();
    }

    const promptBody: any = {
      parts: [{ type: "text" as const, text: promptText }],
    };
    if (modelOverride) promptBody.model = modelOverride;
    if (promptAgent) promptBody.agent = promptAgent;

    await pluginClient.session.promptAsync({
      path: { id: sessionId },
      body: promptBody,
    });
    log("prompt sent");

    let questionPosted = false;
    const seenParts = new Set<string>();

    const eventResult = await pluginClient.event.subscribe();
    const stream = eventResult?.stream;

    if (!stream) {
      log("SSE stream not available, falling back to polling");
      slackSend(channel, "❌ 이벤트 스트림 연결 실패", threadTs);
      sendIPC({ type: "slack_reaction_remove", channel, name: "peperun", timestamp: actualTs });
      return;
    }

    let streamDone = false;
    let lastStreamActivityAt = Date.now();
    let lastDelayNotifiedAt = 0;

    const timeout = setTimeout(() => {
      log("SSE timeout (6min)");
      streamDone = true;
      stream.return(undefined);
    }, 6 * 60 * 1000);

    const idleCheckStart = Date.now();
    const idleCheck = setInterval(async () => {
      if (streamDone) { clearInterval(idleCheck); return; }
      if (Date.now() - idleCheckStart < 2000) return;
      try {
        const { data: messages } = await pluginClient!.session.messages({
          path: { id: sessionId },
        });
        if (Array.isArray(messages)) {
          const lastAssistant = [...messages].reverse().find(
            (m: any) => m.info?.role === "assistant"
          );
          if (lastAssistant?.info?.time?.completed) {
            log(`session ${sessionId} idle via poll fallback`);
            streamDone = true;
            stream.return(undefined);
          }
        }
      } catch {}
    }, 2000);

    const delayCheck = setInterval(() => {
      if (streamDone) { clearInterval(delayCheck); return; }
      const now = Date.now();
      const stalledMs = now - lastStreamActivityAt;
      const shouldNotify = stalledMs >= RESPONSE_STALL_MS
        && (lastDelayNotifiedAt === 0 || now - lastDelayNotifiedAt >= RESPONSE_STALL_NOTIFY_INTERVAL_MS);
      if (shouldNotify) {
        const stalledSec = Math.floor(stalledMs / 1000);
        slackSend(channel, `⏳ 응답이 지연되고 있어요 (${stalledSec}초 경과). 계속 처리 중입니다.`, threadTs);
        lastDelayNotifiedAt = now;
        log(`response stall detected: session=${sessionId} stalled=${stalledSec}s`);
      }
    }, 5000);

    try {
      for await (const event of stream) {
        if (streamDone) break;
        if (!event || !(event as any).type) continue;
        const evt = event as any;

        if (evt.type === "message.part.updated") {
          const part = evt.properties?.part;
          if (!part || part.sessionID !== sessionId) continue;
          lastStreamActivityAt = Date.now();
          lastDelayNotifiedAt = 0;

          const partKey = `${part.type}:${part.id}`;

          if (part.type === "tool" && part.tool === "question" && part.state?.status === "running" && !questionPosted) {
            questionPosted = true;
            const input = part.state?.input || {};
            const questions = input.questions || [];
            let msg = "❓ *질문*\n";
            for (const q of questions) {
              msg += `\n*${q.header || ""}*\n${q.question}\n`;
              if (q.options?.length) {
                q.options.forEach((opt: any, idx: number) => {
                  msg += `  *${idx + 1}.* ${opt.label}${opt.description ? ` — ${opt.description}` : ""}\n`;
                });
              }
            }
            msg += "\n_번호 또는 텍스트로 답해주세요_";
            slackSend(channel, msg, threadTs);
            pendingQuestions.set(threadTs, { sessionId, threadTs, channel, createdAt: Date.now() });
            log(`question forwarded to slack for thread ${threadTs}`);
            sendIPC({ type: "slack_reaction_remove", channel, name: "peperun", timestamp: actualTs });
            clearTimeout(timeout);
            return;
          }

          if (part.type === "tool" && part.tool !== "question" && part.state?.status === "running") {
            if (!seenParts.has(partKey)) {
              seenParts.add(partKey);
              const title = part.state?.title || "";
              const toolName = part.tool || "";
              const input = part.state?.input || {};
              let detail = title || toolName;
              if (!title && input) {
                const params = Object.entries(input)
                  .filter(([k, v]) => v && typeof v === "string" && (v as string).length < 100)
                  .map(([k, v]) => `${k}=${v}`)
                  .slice(0, 2)
                  .join(" ");
                if (params) detail = `${toolName} ${params}`;
              }
              if (detail) {
                slackSend(channel, `🔧 _${detail}_`, threadTs);
                log(`stream: 🔧 _${detail}_`);
              }
            }
          }

          if (part.type === "reasoning" && part.text && !seenParts.has(partKey)) {
            seenParts.add(partKey);
            const snippet = part.text.length > 200 ? part.text.slice(0, 200) + "…" : part.text;
            slackSend(channel, `💭 ${snippet}`, threadTs);
            log(`stream: 💭`);
          }
        }

        if (evt.type === "session.idle" && evt.properties?.sessionID === sessionId) {
          lastStreamActivityAt = Date.now();
          lastDelayNotifiedAt = 0;
          log(`session ${sessionId} idle via SSE`);
          streamDone = true;
          break;
        }

        if (evt.type === "todo.updated" && evt.properties?.sessionID === sessionId) {
          lastStreamActivityAt = Date.now();
          lastDelayNotifiedAt = 0;
          const todos = evt.properties.todos || [];
          if (todos.length > 0) {
            let msg = "📋 *Plan*\n";
            for (const t of todos) {
              const icon = t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⬜";
              msg += `${icon} ${t.content}\n`;
            }
            slackSend(channel, msg, threadTs);
            log(`stream: todo.updated (${todos.length} items)`);
          }
        }

        if (!["message.part.updated", "session.idle", "session.status", "todo.updated"].includes(evt.type)) {
          if (evt.properties?.sessionID === sessionId || !evt.properties?.sessionID) {
            log(`SSE event: ${evt.type} ${JSON.stringify(evt.properties || {}).slice(0, 100)}`);
          }
        }
      }
    } catch (streamErr: any) {
      log(`SSE error: ${streamErr.message}`);
    } finally {
      streamDone = true;
      clearTimeout(timeout);
      clearInterval(idleCheck);
      clearInterval(delayCheck);
    }

    try {
      const { data: messages } = await pluginClient.session.messages({
        path: { id: sessionId },
      });
      if (Array.isArray(messages)) {
        const lastAssistant = [...messages].reverse().find(
          (m: any) => m.info?.role === "assistant"
        );
        if (lastAssistant) {
          const textParts = (lastAssistant.parts as any[])
            .filter((p: any) => p.type === "text" && p.text)
            .map((p: any) => p.text)
            .join("\n");
          if (textParts) sendLongText(channel, textParts, threadTs);
        }
      }
    } catch (fetchErr: any) {
      log(`final fetch error: ${fetchErr.message}`);
    }

    sendIPC({ type: "slack_reaction_remove", channel, name: "peperun", timestamp: actualTs });
    log(`session ${sessionId} completed`);
  } catch (e: any) {
    log(`error: ${e.message}`);
    slackSend(channel, `❌ 오류: ${e.message}`, ts);
  }
}

function splitText(text: string): string[] {
  const chunks: string[] = [];
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
  return chunks;
}

function sendLongText(channel: string, text: string, threadTs?: string) {
  const hasCodeBlock = text.includes("```");
  log(`sendLongText: len=${text.length} hasCode=${hasCodeBlock}`);
  if (text.length > SLACK_MSG_LIMIT || (hasCodeBlock && text.length > 2000)) {
    sendIPC({ type: "slack_upload", channel, content: text, threadTs, filename: "response.md", title: "Response" });
    return;
  }
  slackSend(channel, text, threadTs);
}

async function handleCommand(channel: string, text: string, ts: string): Promise<boolean> {
  if (!pluginClient) return false;
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === "!model") {
    const arg = parts.slice(1).join(" ").trim();
    if (!arg) {
      const current = modelOverride
        ? `${modelOverride.providerID}/${modelOverride.modelID}`
        : "(default)";
      const lines = [`*현재 모델:* \`${current}\``, "", "*사용 가능:*"];
      try {
        const { data: config } = await pluginClient.config.get();
        if (config?.provider) {
          for (const [provId, prov] of Object.entries(config.provider as Record<string, any>)) {
            for (const modelId of Object.keys(prov.models || {})) {
              lines.push(`• \`${provId}/${modelId}\``);
            }
          }
        }
      } catch {
        lines.push("_(모델 목록을 가져올 수 없습니다)_");
      }
      slackSend(channel, lines.join("\n"), ts);
      return true;
    }
    if (arg === "reset" || arg === "default") {
      modelOverride = null;
      slackSend(channel, "✅ 기본 모델로 복원", ts);
      return true;
    }
    const match = arg.match(/^([^/]+)\/(.+)$/);
    if (match) {
      modelOverride = { providerID: match[1], modelID: match[2] };
      slackSend(channel, `✅ 모델 변경: \`${arg}\``, ts);
    } else {
      slackSend(channel, `❌ 형식: \`!model provider/model\` (예: \`!model kiro/claude-sonnet-4-6\`)`, ts);
    }
    return true;
  }

  if (cmd === "!reset") {
    delete sessions[ts];
    saveSessions();
    slackSend(channel, "✅ 세션 리셋됨. 다음 메시지부터 새 세션.", ts);
    return true;
  }

  if (cmd === "!agent") {
    const arg = parts.slice(1).join(" ").trim();
    if (!arg) {
      slackSend(channel, `*현재 에이전트:* \`${agentOverride || "(default)"}\``, ts);
      return true;
    }
    if (arg === "reset" || arg === "default") {
      agentOverride = null;
      slackSend(channel, "✅ 기본 에이전트로 복원", ts);
      return true;
    }
    agentOverride = arg;
    slackSend(channel, `✅ 에이전트 변경: \`${arg}\``, ts);
    return true;
  }

  if (cmd === "!dir") {
    const arg = parts.slice(1).join(" ").trim();
    if (!arg) {
      const currentDir = sessions[ts]?.directory || defaultDirectory || "(기본)";
      slackSend(channel, `*현재 워크스페이스:* \`${currentDir}\``, ts);
      return true;
    }
    if (!sessions[ts]) {
      sessions[ts] = { sessionId: "", channel, lastUsed: Date.now(), directory: arg };
    } else {
      sessions[ts].directory = arg;
    }
    saveSessions();
    slackSend(channel, `✅ 워크스페이스 변경: \`${arg}\`\n다음 메시지부터 이 디렉토리에서 세션 생성.`, ts);
    return true;
  }

  if (cmd === "!attach") {
    const arg = parts.slice(1).join(" ").trim();
    if (!arg) {
      const currentSession = sessions[ts]?.sessionId || "(없음)";
      slackSend(channel, `*현재 세션:* \`${currentSession}\``, ts);
      return true;
    }
    let sessionId = arg;
    const urlMatch = arg.match(/\/session\/(ses_[a-zA-Z0-9]+)/);
    if (urlMatch) {
      sessionId = urlMatch[1];
    }
    if (!sessionId.startsWith("ses_")) {
      slackSend(channel, `❌ 형식: \`!attach ses_xxx\` 또는 OpenCode URL 붙여넣기`, ts);
      return true;
    }
    saveSession(ts, sessionId, channel, sessions[ts]?.directory);
    slackSend(channel, `✅ 세션 연결: \`${sessionId}\`\n이 스레드의 메시지가 해당 세션으로 전달됩니다.`, ts);
    return true;
  }

  if (cmd === "!help") {
    const help = [
      "*사용 가능한 명령:*",
      "• `!model` — 현재 모델 확인 / 변경",
      "• `!model provider/model` — 모델 변경",
      "• `!model reset` — 기본 모델 복원",
      "• `!agent` — 현재 에이전트 확인",
      "• `!agent build` — 에이전트 변경 (build, plan 등)",
      "• `!agent reset` — 기본 에이전트 복원",
      "• `!dir` — 현재 워크스페이스 확인",
      "• `!dir /path/to/project` — 워크스페이스 변경",
      "• `!attach ses_xxx` — 기존 세션 연결 (URL 붙여넣기 가능)",
      "• `!reset` — 현재 스레드 세션 리셋",
      "• `!help` — 이 도움말",
    ];
    slackSend(channel, help.join("\n"), ts);
    return true;
  }

  return false;
}

function startWorker(env: Record<string, string>) {
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), "socket-worker.js");
  log(`starting worker: ${workerPath}`);

  worker = spawn("node", [workerPath], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    detached: false,
  });

  worker.on("message", (msg: any) => {
    if (msg?.type === "slack_event") {
      const isAllowed = !allowedUsers || !allowlistReady || allowedUsers.has(msg.user);
      const isThreadReply = msg.threadTs !== msg.messageTs;

      if (!isAllowed && !isThreadReply) {
        log(`blocked user: ${msg.user} (new thread)`);
        return;
      }
      handleMessage(msg.channel, msg.text, msg.threadTs, msg.messageTs, isAllowed);
    } else if (msg?.type === "resolved_emails") {
      if (allowedUsers && msg.users) {
        for (const uid of msg.users) {
          allowedUsers.add(uid);
        }
        log(`resolved email users: ${msg.users.join(", ")}`);
      }
      allowlistReady = true;
    }
  });

  worker.on("exit", (code) => {
    log(`worker exited: code=${code}`);
    worker = null;
    if (initialized) {
      setTimeout(() => { log("restarting worker..."); startWorker(env); }, 5000);
    }
  });

  log("worker spawned");
}

function stopWorker() {
  if (worker) {
    worker.removeAllListeners();
    worker.kill("SIGTERM");
    worker = null;
  }
  log("worker stopped");
}

const slackStatusTool = tool({
  description: "Slack 에이전트 상태 확인",
  args: {},
  async execute() {
    const status = worker && !worker.killed ? "running" : "stopped";
    const sessionCount = Object.keys(sessions).length;
    return { output: `Slack agent: ${status}, sessions: ${sessionCount}` };
  },
});

const pluginModule: PluginModule = {
  id: "opencode-slack-agent",
  server: async (input: PluginInput, options?: PluginOptions) => {
    log("server() called");
    if (initialized) return { tool: { slack_status: slackStatusTool } };

    const botToken = (options?.SLACK_BOT_TOKEN as string) || process.env.SLACK_BOT_TOKEN || "";
    const appToken = (options?.SLACK_APP_TOKEN as string) || process.env.SLACK_APP_TOKEN || "";

    const enabled = process.env.SLACK_AGENT_ENABLED
      ?? (options?.SLACK_AGENT_ENABLED as string)
      ?? "true";
    if (enabled === "false" || enabled === "0") {
      log("DISABLED — SLACK_AGENT_ENABLED=false");
      initialized = true;
      return { tool: { slack_status: slackStatusTool } };
    }

    if (!botToken || !appToken) {
      log("DISABLED — missing tokens");
      initialized = true;
      return { tool: { slack_status: slackStatusTool } };
    }

    pluginClient = input.client;
    defaultDirectory = (options?.DEFAULT_DIRECTORY as string) || process.env.SLACK_DEFAULT_DIRECTORY || input.directory;
    sessionsPath = join(input.directory, "slack-sessions.json");
    loadSessions();
    log(`sessions loaded: ${Object.keys(sessions).length} entries from ${sessionsPath}`);

    const allowedUsersStr = (options?.ALLOWED_USERS as string) || process.env.SLACK_ALLOWED_USERS || "";
    let emailsToResolve: string[] = [];
    if (allowedUsersStr) {
      const entries = allowedUsersStr.split(",").map(u => u.trim()).filter(Boolean);
      allowedUsers = new Set(entries.filter(e => e.startsWith("U")));
      emailsToResolve = entries.filter(e => e.includes("@"));
      log(`allowed users: ${[...allowedUsers].join(", ")}${emailsToResolve.length ? ` + ${emailsToResolve.length} emails to resolve` : ""}`);
    }

    const workerEnv: Record<string, string> = {
      SLACK_BOT_TOKEN: botToken,
      SLACK_APP_TOKEN: appToken,
    };
    const caCerts = (options?.NODE_EXTRA_CA_CERTS as string) || process.env.NODE_EXTRA_CA_CERTS || "";
    if (caCerts) workerEnv.NODE_EXTRA_CA_CERTS = caCerts;

    if (emailsToResolve.length > 0) {
      allowlistReady = false;
    }
    startWorker(workerEnv);
    if (emailsToResolve.length > 0) {
      sendIPC({ type: "resolve_emails", emails: emailsToResolve });
    }
    initialized = true;
    log("plugin initialized (hybrid sidecar + persistent sessions)");

    return {
      tool: { slack_status: slackStatusTool },
      "permission.ask": async (input: any, output: any) => {
        const sessionEntry = Object.entries(sessions).find(
          ([_, s]) => s.sessionId === input.sessionID
        );
        if (!sessionEntry) return;
        const [threadTs, session] = sessionEntry;

        pendingPermissions.set(input.id, {
          permissionId: input.id,
          sessionId: input.sessionID,
          threadTs,
          channel: session.channel,
          createdAt: Date.now(),
        });

        let msg = "⚠️ *권한 요청*\n";
        msg += `\`${input.title}\`\n`;
        if (input.pattern) {
          const patterns = Array.isArray(input.pattern) ? input.pattern.join(", ") : input.pattern;
          msg += `패턴: \`${patterns}\`\n`;
        }
        msg += "\n*1.* 허용 (이번만)\n*2.* 항상 허용\n*3.* 거부\n";
        msg += "_1/y/yes, 2/always, 3/n/no 로 답해주세요_";

        slackSend(session.channel, msg, threadTs);
        log(`permission.ask forwarded to slack: ${input.id} (${input.title})`);

        output.status = "ask";
      },
      dispose: async () => {
        stopWorker();
        pluginClient = null;
        initialized = false;
        log("shutdown");
      },
    };
  },
};

export default pluginModule;
