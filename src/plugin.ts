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
const DEFAULT_ATTACH_TIMEOUT_SEC = 600;
const BG_OUTPUT_REQUEST_TIMEOUT_MS = 15_000;
const BG_OUTPUT_CANDIDATE_PATHS = ["/background/output", "/background_output", "/api/background/output"] as const;
const BG_TASK_ID_PATTERN = /^bg_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const AUTO_ATTACH_MAX_TASKS_PER_MESSAGE = 3;
const AUTO_ATTACH_MAX_MONITOR_BUDGET_MS = 120_000;

let initialized = false;
let worker: ChildProcess | null = null;
let pluginClient: PluginInput["client"] | null = null;
let modelOverride: { providerID: string; modelID: string } | null = null;
let agentOverride: string | null = null;
let sessionsPath: string = "";
let sessions: Record<string, { sessionId: string; channel: string; lastUsed: number; directory?: string; lastSyncedMessageId?: string }> = {};
let defaultDirectory: string = "";
let allowedUsers: Set<string> | null = null;
let allowlistReady = true;
let attachBgTimeoutMs = DEFAULT_ATTACH_TIMEOUT_SEC * 1000;
let cachedBackgroundOutputPath: string | null = null;

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
    let syncCursor = sessions[threadTs]?.lastSyncedMessageId;

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
      if (!syncCursor) {
        try {
          const { data: preMessages } = await pluginClient.session.messages({
            path: { id: sessionId },
          });
          if (Array.isArray(preMessages) && preMessages.length > 0) {
            syncCursor = preMessages[preMessages.length - 1]?.id;
          }
        } catch (preFetchErr: any) {
          log(`pre-prompt cursor fetch error: ${preFetchErr.message}`);
        }
      }
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
    const backgroundTaskIDs = new Set<string>();

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

          if (part.type === "tool" && part.tool !== "question") {
            const detectedIds = extractBackgroundTaskIdsFromPart(part);
            for (const detectedId of detectedIds) {
              if (!backgroundTaskIDs.has(detectedId)) {
                backgroundTaskIDs.add(detectedId);
                slackSend(channel, `🧵 bg 작업 감지: \`${detectedId}\` (완료 시 결과를 자동 확인합니다)`, threadTs);
                log(`detected background task from stream: ${detectedId}`);
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
          log(`session ${sessionId} idle via SSE`);
          streamDone = true;
          break;
        }

        if (evt.type === "todo.updated" && evt.properties?.sessionID === sessionId) {
          lastStreamActivityAt = Date.now();
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
      syncCursor = await syncAssistantMessagesSinceCursor(sessionId, channel, threadTs, syncCursor);
      if (syncCursor && sessions[threadTs]) {
        sessions[threadTs].lastSyncedMessageId = syncCursor;
        saveSessions();
      }
    } catch (fetchErr: any) {
      log(`final sync error: ${fetchErr.message}`);
    }

    if (backgroundTaskIDs.size > 0) {
      const autoTaskIds = [...backgroundTaskIDs].slice(0, AUTO_ATTACH_MAX_TASKS_PER_MESSAGE);
      const autoAttachStartedAt = Date.now();
      if (backgroundTaskIDs.size > autoTaskIds.length) {
        const skipped = backgroundTaskIDs.size - autoTaskIds.length;
        slackSend(channel, `ℹ️ 감지된 bg 작업이 많아 상위 ${autoTaskIds.length}개만 자동 확인합니다. (${skipped}개는 수동 attach 권장)`, threadTs);
      }
      for (const bgTaskID of autoTaskIds) {
        const remainingBudgetMs = AUTO_ATTACH_MAX_MONITOR_BUDGET_MS - (Date.now() - autoAttachStartedAt);
        if (remainingBudgetMs <= 0) {
          slackSend(channel, "⏱️ 자동 bg 확인 예산(2분)을 초과하여 추가 작업은 건너뜁니다. 필요 시 `!attach bg_xxx`로 확인하세요.", threadTs);
          break;
        }
        const state = await handleAttachBackgroundTask(channel, bgTaskID, threadTs, {
          announceStart: false,
          renderPayloadOnComplete: false,
          maxWaitMs: remainingBudgetMs,
        });
        if (state === "completed") {
          try {
            syncCursor = await syncAssistantMessagesSinceCursor(sessionId, channel, threadTs, syncCursor);
            if (syncCursor && sessions[threadTs]) {
              sessions[threadTs].lastSyncedMessageId = syncCursor;
              saveSessions();
            }
          } catch (bgSyncErr: any) {
            log(`bg completion sync error (${bgTaskID}): ${bgSyncErr.message}`);
          }
        }
      }
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

function attachPollIntervalMs(elapsedMs: number): number {
  const base = elapsedMs < 60_000 ? 5_000 : elapsedMs < 300_000 ? 15_000 : 30_000;
  const jitter = Math.floor(Math.random() * 3_001) - 1_500;
  return Math.max(1_000, base + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stringifyLimited(payload: unknown, maxLength = 3000): string {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...(truncated)`;
}

function parsePositiveFiniteSeconds(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function resolveAttachTimeoutMs(optionTimeoutSec: unknown): number {
  const fromOption = parsePositiveFiniteSeconds(optionTimeoutSec);
  if (fromOption !== null) return Math.round(fromOption * 1000);
  const fromEnv = parsePositiveFiniteSeconds(process.env.ATTACH_TIMEOUT_SEC);
  if (fromEnv !== null) return Math.round(fromEnv * 1000);
  return DEFAULT_ATTACH_TIMEOUT_SEC * 1000;
}

function timeoutLabel(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec % 60 === 0) return `${sec / 60}분`;
  return `${sec}초`;
}

function collectBackgroundTaskIds(value: unknown, found: Set<string>) {
  if (value == null) return;
  if (typeof value === "string") {
    const matches = value.match(/\bbg_[A-Za-z0-9][A-Za-z0-9_-]*\b/g);
    if (matches) {
      for (const id of matches) {
        if (BG_TASK_ID_PATTERN.test(id)) found.add(id);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectBackgroundTaskIds(item, found);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if ((k === "task_id" || k === "taskId") && typeof v === "string" && BG_TASK_ID_PATTERN.test(v)) {
        found.add(v);
      }
      collectBackgroundTaskIds(v, found);
    }
  }
}

function extractBackgroundTaskIdsFromPart(part: any): string[] {
  const found = new Set<string>();
  collectBackgroundTaskIds(part?.state?.input, found);
  collectBackgroundTaskIds(part?.state?.output, found);
  collectBackgroundTaskIds(part?.state?.result, found);
  collectBackgroundTaskIds(part?.metadata, found);
  return [...found];
}

function normalizeBackgroundStateToken(token: string): "running" | "completed" | "error" | "cancelled" | "not_found" | "unknown" {
  const normalized = token.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["completed", "complete", "done", "succeeded", "success", "finished"].includes(normalized)) return "completed";
  if (["error", "failed", "failure"].includes(normalized)) return "error";
  if (["cancelled", "canceled", "aborted", "timed_out", "timeout"].includes(normalized)) return "cancelled";
  if (["running", "pending", "in_progress", "queued", "processing"].includes(normalized)) return "running";
  if (["not_found", "missing"].includes(normalized)) return "not_found";
  return "unknown";
}

function statePriority(state: "running" | "completed" | "error" | "cancelled" | "not_found" | "unknown"): number {
  switch (state) {
    case "completed": return 5;
    case "error": return 4;
    case "cancelled": return 3;
    case "not_found": return 2;
    case "running": return 1;
    default: return 0;
  }
}

function deriveBackgroundStateFromText(text: string): "running" | "completed" | "error" | "cancelled" | "not_found" | "unknown" {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return "unknown";
  if (/\bnot[\s_-]?found\b/.test(normalized) || /\bmissing\b/.test(normalized)) return "not_found";
  if (/\bcancel(?:ed|led)\b/.test(normalized) || /\baborted\b/.test(normalized) || /\btimed[\s_-]?out\b/.test(normalized)) return "cancelled";
  if (/\b(?:completed|complete|done|succeeded|success|finished)\b/.test(normalized)) return "completed";
  if (/\b(?:failed|failure|error)\b/.test(normalized)) return "error";
  if (/\b(?:running|pending|in[\s_-]?progress|queued|processing)\b/.test(normalized)) return "running";
  return "unknown";
}

function deriveBackgroundStateFromObject(value: unknown, depth = 0): "running" | "completed" | "error" | "cancelled" | "not_found" | "unknown" {
  if (typeof value === "string") {
    const tokenState = normalizeBackgroundStateToken(value);
    if (tokenState !== "unknown") return tokenState;
    return deriveBackgroundStateFromText(value);
  }
  if (!value || typeof value !== "object" || depth > 3) return "unknown";
  if (Array.isArray(value)) {
    let bestState: "running" | "completed" | "error" | "cancelled" | "not_found" | "unknown" = "unknown";
    for (const entry of value) {
      const nested = deriveBackgroundStateFromObject(entry, depth + 1);
      if (statePriority(nested) > statePriority(bestState)) {
        bestState = nested;
      }
      if (bestState === "completed") return bestState;
    }
    return bestState;
  }

  const obj = value as Record<string, unknown>;
  const orderedBooleanKeys: Array<[string, "running" | "completed" | "error" | "cancelled" | "not_found"]> = [
    ["not_found", "not_found"],
    ["cancelled", "cancelled"],
    ["canceled", "cancelled"],
    ["aborted", "cancelled"],
    ["timed_out", "cancelled"],
    ["error", "error"],
    ["failed", "error"],
    ["completed", "completed"],
    ["done", "completed"],
    ["running", "running"],
    ["pending", "running"],
    ["in_progress", "running"],
  ];

  for (const [k, state] of orderedBooleanKeys) {
    if (obj[k] === true) return state;
  }

  for (const [key, raw] of Object.entries(obj)) {
    if (typeof raw !== "string") continue;
    const keyLower = key.toLowerCase();
    if (keyLower === "status" || keyLower === "state" || keyLower.endsWith("_status") || keyLower.endsWith("_state")) {
      const normalized = normalizeBackgroundStateToken(raw);
      if (normalized !== "unknown") return normalized;
      const fromStatusText = deriveBackgroundStateFromText(raw);
      if (fromStatusText !== "unknown") return fromStatusText;
    }
  }

  for (const [key, raw] of Object.entries(obj)) {
    if (typeof raw !== "string") continue;
    const keyLower = key.toLowerCase();
    if (["raw", "message", "detail", "text", "output", "result"].includes(keyLower)) {
      const fromText = deriveBackgroundStateFromText(raw);
      if (fromText !== "unknown") return fromText;
    }
  }

  for (const nested of Object.values(obj)) {
    const derived = deriveBackgroundStateFromObject(nested, depth + 1);
    if (derived !== "unknown") return derived;
  }

  return "unknown";
}

function deriveBackgroundState(payload: unknown): "running" | "completed" | "error" | "cancelled" | "not_found" | "unknown" {
  const structured = deriveBackgroundStateFromObject(payload);
  if (structured !== "unknown") return structured;
  if (typeof payload === "string") return deriveBackgroundStateFromText(payload);
  if (payload && typeof payload === "object") {
    const fromText = deriveBackgroundStateFromText(stringifyLimited(payload, 2_000));
    if (fromText !== "unknown") return fromText;
  }
  return "unknown";
}

function opencodeBaseUrl(): string {
  const portArgIndex = process.argv.indexOf("--port");
  const portFromArg = portArgIndex >= 0 ? process.argv[portArgIndex + 1] : undefined;
  const port = portFromArg || process.env.OPENCODE_PORT || "4096";
  return `http://127.0.0.1:${port}`;
}

function opencodeAuthHeader(): string | undefined {
  const password = process.env.OPENCODE_SERVER_PASSWORD || "";
  if (!password) return undefined;
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function isEndpointNotFound404Body(body: string): boolean {
  const text = body.trim().toLowerCase();
  if (!text) return false;
  if (text === "not found") return true;
  if (text.includes("cannot post") || text.includes("endpoint") || text.includes("route")) return true;
  if (text.includes("method not allowed")) return true;
  return false;
}

function parseResponsePayload(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function callBackgroundOutput(bgTaskID: string, requestTimeoutMs = BG_OUTPUT_REQUEST_TIMEOUT_MS): Promise<{ ok: boolean; statusCode: number; payload?: unknown; error?: string; unsupported?: boolean; retryable?: boolean }> {
  const baseUrl = opencodeBaseUrl();
  const authHeader = opencodeAuthHeader();
  const candidatePaths = cachedBackgroundOutputPath
    ? [cachedBackgroundOutputPath, ...BG_OUTPUT_CANDIDATE_PATHS.filter(path => path !== cachedBackgroundOutputPath)]
    : [...BG_OUTPUT_CANDIDATE_PATHS];
  let saw404 = false;
  let sawEndpointStyle404 = true;

  for (const path of candidatePaths) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify({ task_id: bgTaskID, from_end: true, message_limit: 50 }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });

      if (response.status === 404) {
        saw404 = true;
        const notFoundBody = await response.text();
        if (!isEndpointNotFound404Body(notFoundBody)) {
          sawEndpointStyle404 = false;
          cachedBackgroundOutputPath = path;
        }
        continue;
      }

      cachedBackgroundOutputPath = path;
      if (!response.ok) {
        return { ok: false, statusCode: response.status, error: await response.text() };
      }

      const text = await response.text();
      return { ok: true, statusCode: response.status, payload: parseResponsePayload(text) };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isTimeout = error instanceof Error
        && (error.name === "TimeoutError" || error.name === "AbortError" || msg.toLowerCase().includes("timeout"));
      if (isTimeout) {
        return { ok: false, statusCode: 408, error: msg, retryable: true };
      }
      return { ok: false, statusCode: 500, error: msg, retryable: false };
    }
  }

  if (saw404 && sawEndpointStyle404) {
    return { ok: false, statusCode: 404, unsupported: true, error: "Background output endpoint was not found." };
  }
  if (saw404) {
    return { ok: false, statusCode: 404, unsupported: false, error: `Background task was not found: ${bgTaskID}` };
  }
  return { ok: false, statusCode: 500, error: "Unknown background output call failure." };
}

type AttachBackgroundOptions = {
  announceStart?: boolean;
  renderPayloadOnComplete?: boolean;
  maxWaitMs?: number;
};

async function syncAssistantMessagesSinceCursor(
  sessionId: string,
  channel: string,
  threadTs: string,
  cursorId?: string,
): Promise<string | undefined> {
  if (!pluginClient) return cursorId;

  const { data: messages } = await pluginClient.session.messages({
    path: { id: sessionId },
  });
  if (!Array.isArray(messages) || messages.length === 0) return cursorId;

  let startIndex = 0;
  if (cursorId) {
    const cursorIdx = messages.findIndex((m: any) => m.id === cursorId);
    if (cursorIdx >= 0) startIndex = cursorIdx + 1;
  }

  const unsyncedAssistantMessages = messages
    .slice(startIndex)
    .filter((m: any) => m.info?.role === "assistant")
    .sort((a: any, b: any) => (a.info?.time?.created || 0) - (b.info?.time?.created || 0));

  for (const msg of unsyncedAssistantMessages) {
    if (!Array.isArray(msg.parts)) {
      log(`skip assistant message with non-array parts: ${msg.id || "unknown"}`);
      continue;
    }
    const textParts = (msg.parts as any[])
      .filter((p: any) => p.type === "text" && p.text)
      .map((p: any) => p.text)
      .join("\n");
    if (textParts) sendLongText(channel, textParts, threadTs);
  }

  const lastMsg = messages[messages.length - 1];
  return lastMsg?.id || cursorId;
}

async function handleAttachBackgroundTask(
  channel: string,
  bgTaskID: string,
  ts: string,
  options: AttachBackgroundOptions = {},
): Promise<"completed" | "error" | "cancelled" | "not_found" | "timeout" | "unsupported" | "access_denied"> {
  const announceStart = options.announceStart !== false;
  const renderPayloadOnComplete = options.renderPayloadOnComplete !== false;
  const effectiveTimeoutMs = Math.max(1_000, Math.min(attachBgTimeoutMs, options.maxWaitMs ?? attachBgTimeoutMs));
  if (announceStart) {
    slackSend(channel, `🔗 bg 작업 attach: \`${bgTaskID}\`\n완료까지 상태를 확인합니다.`, ts);
  }
  const startedAt = Date.now();

  while (Date.now() - startedAt < effectiveTimeoutMs) {
    const remainingMs = effectiveTimeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) break;
    const requestTimeoutMs = Math.min(BG_OUTPUT_REQUEST_TIMEOUT_MS, remainingMs);
    if (requestTimeoutMs <= 0) break;
    const probe = await callBackgroundOutput(bgTaskID, requestTimeoutMs);
    if (!probe.ok) {
      if (probe.unsupported) {
        slackSend(channel, "❌ 현재 OpenCode 서버에서 background output API를 찾을 수 없습니다.", ts);
        return "unsupported";
      }
      if (probe.retryable) {
        log(`retryable background output timeout: ${bgTaskID} ${probe.error || "timeout"}`);
        const retryWaitMs = attachPollIntervalMs(Date.now() - startedAt);
        const retryRemainingMs = effectiveTimeoutMs - (Date.now() - startedAt);
        if (retryRemainingMs <= 0) break;
        await sleep(Math.min(retryWaitMs, retryRemainingMs));
        continue;
      }
      if (probe.statusCode === 401 || probe.statusCode === 403) {
        slackSend(channel, `❌ bg 작업 접근 권한이 없습니다: \`${bgTaskID}\``, ts);
        return "access_denied";
      }
      if (probe.statusCode === 404) {
        slackSend(channel, `❌ bg 작업을 찾을 수 없습니다: \`${bgTaskID}\``, ts);
        return "not_found";
      }
      const errMessage = probe.error ? stringifyLimited(probe.error, 500) : "unknown error";
      slackSend(channel, `❌ bg 조회 오류: ${errMessage}`, ts);
      return "error";
    }

    const state = deriveBackgroundState(probe.payload);
    if (state === "completed") {
      if (renderPayloadOnComplete) {
        sendLongText(channel, `✅ bg 작업 완료: \`${bgTaskID}\`\n${stringifyLimited(probe.payload)}`, ts);
      } else {
        slackSend(channel, `✅ bg 작업 완료: \`${bgTaskID}\``, ts);
      }
      return "completed";
    }
    if (state === "error") {
      sendLongText(channel, `❌ bg 작업 실패: \`${bgTaskID}\`\n${stringifyLimited(probe.payload)}`, ts);
      return "error";
    }
    if (state === "cancelled") {
      slackSend(channel, `🚫 bg 작업이 취소되었습니다: \`${bgTaskID}\``, ts);
      return "cancelled";
    }
    if (state === "not_found") {
      slackSend(channel, `❌ bg 작업을 찾을 수 없습니다: \`${bgTaskID}\``, ts);
      return "not_found";
    }

    const waitMs = attachPollIntervalMs(Date.now() - startedAt);
    const waitRemainingMs = effectiveTimeoutMs - (Date.now() - startedAt);
    if (waitRemainingMs <= 0) break;
    await sleep(Math.min(waitMs, waitRemainingMs));
  }

  log(`attach bg timeout without terminal state: ${bgTaskID}`);
  slackSend(channel, `⏱️ bg 작업 대기 시간 초과 (${timeoutLabel(effectiveTimeoutMs)}): \`${bgTaskID}\`\n다시 \`!attach ${bgTaskID}\`로 이어서 확인할 수 있습니다.`, ts);
  return "timeout";
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

    if (arg.startsWith("bg_")) {
      if (!BG_TASK_ID_PATTERN.test(arg)) {
        slackSend(channel, "❌ 형식: `!attach bg_xxx` (영문/숫자/`_`/`-`만 허용)", ts);
        return true;
      }
      await handleAttachBackgroundTask(channel, arg, ts);
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

  if (cmd === "!sync") {
    const session = sessions[ts];
    if (!session?.sessionId) {
      slackSend(channel, "❌ 이 스레드에 연결된 세션이 없습니다.", ts);
      return true;
    }
    try {
      const { data: messages } = await pluginClient.session.messages({
        path: { id: session.sessionId },
      });
      if (!Array.isArray(messages) || messages.length === 0) {
        slackSend(channel, "ℹ️ 세션에 메시지가 없습니다.", ts);
        return true;
      }

      const cursor = session.lastSyncedMessageId;
      let startIndex = 0;
      if (cursor) {
        const cursorIdx = messages.findIndex((m: any) => m.id === cursor);
        if (cursorIdx >= 0) startIndex = cursorIdx + 1;
      }

      const unsyncedMessages = messages.slice(startIndex).filter(
        (m: any) => m.info?.role === "assistant" || m.info?.role === "user"
      ).sort((a: any, b: any) => (a.info?.time?.created || 0) - (b.info?.time?.created || 0));

      if (unsyncedMessages.length === 0) {
        slackSend(channel, "✅ 동기화할 새 메시지가 없습니다.", ts);
        return true;
      }

      for (const msg of unsyncedMessages) {
        const role = msg.info?.role;
        const textParts = (msg.parts as any[])
          .filter((p: any) => p.type === "text" && p.text)
          .map((p: any) => p.text)
          .join("\n");
        if (!textParts) continue;

        if (role === "user") {
          const quoted = textParts.split("\n").map((l: string) => `> ${l}`).join("\n");
          slackSend(channel, `👤 *User:*\n${quoted}`, ts);
        } else {
          sendLongText(channel, `🤖 *Assistant:*\n${textParts}`, ts);
        }
      }

      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.id) {
        sessions[ts].lastSyncedMessageId = lastMsg.id;
        saveSessions();
      }

      const syncedCount = unsyncedMessages.filter((m: any) => {
        const parts = (m.parts as any[]).filter((p: any) => p.type === "text" && p.text);
        return parts.length > 0;
      }).length;
      slackSend(channel, `✅ ${syncedCount}개 메시지 동기화 완료.`, ts);
    } catch (err: any) {
      log(`!sync error: ${err.message}`);
      slackSend(channel, `❌ 동기화 오류: ${err.message}`, ts);
    }
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
      "• `!attach bg_xxx` — 백그라운드 작업 상태 attach",
      "• `!sync` — 클라이언트 메시지를 슬랙으로 동기화",
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
    attachBgTimeoutMs = resolveAttachTimeoutMs(options?.ATTACH_TIMEOUT_SEC);
    log(`attach timeout set to ${attachBgTimeoutMs}ms`);
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
