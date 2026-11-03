# opencode-slack-agent

OpenCode plugin that connects Slack to your AI agent. Receives DMs and @mentions via Socket Mode, creates OpenCode sessions to process them, and sends responses back to Slack.

## How It Works

```
opencode serve
  └─ [plugin: opencode-slack-agent]
       ├─ Plugin (Bun) — session management, OpenCode client, IPC
       └─ Socket Worker (Node) — Slack Socket Mode, message delivery
            ├─ DM or @mention received → IPC → plugin
            ├─ Plugin creates/reuses OpenCode session
            ├─ Streams tool progress (🔧) to Slack thread
            └─ Sends final response (or uploads file for long responses)
```

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Enable **Socket Mode** → generate App-Level Token (`xapp-...`) with scope `connections:write`
3. Add **Bot Token Scopes** (OAuth & Permissions):
   - `im:read`, `im:write`, `im:history`, `channels:read`, `chat:write`
   - `reactions:write`, `reactions:read`, `files:read`, `files:write`
4. Add **Event Subscriptions** (Subscribe to bot events):
   - `message.im`, `app_mention`
5. **Install to Workspace** → save Bot Token (`xoxb-...`)

### 2. Install the Plugin

```bash
opencode plugin opencode-slack-agent --global
```

### 3. Configure

Add plugin with tokens to `~/.config/opencode/opencode.json`:

**OpenCode V2**

```json
{
  "plugins": [
    {
      "package": "opencode-slack-agent",
      "options": {
        "SLACK_BOT_TOKEN": "xoxb-...",
        "SLACK_APP_TOKEN": "xapp-..."
      }
    }
  ]
}
```

**OpenCode V1**

```json
{
  "plugin": [
    ["opencode-slack-agent", {
      "SLACK_BOT_TOKEN": "xoxb-...",
      "SLACK_APP_TOKEN": "xapp-..."
    }]
  ]
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `SLACK_BOT_TOKEN` | — | Required. Bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | — | Required. App-level token (`xapp-...`) |
| `DEFAULT_DIRECTORY` | serve directory | Default workspace for new sessions |
| `DEFAULT_AGENT` | — | Agent name to use for prompts in Slack threads. Reads plugin option first, then `SLACK_DEFAULT_AGENT` env var. Can be overridden per-message with `@<agent>` or per-thread with `!agent`; cleared by `!agent reset`. Useful when the global opencode default agent has an identity you don't want exposed in Slack (e.g., a chat-facing persona) |
| `ALLOWED_USERS` | — | Comma-separated Slack user IDs or emails. If unset, everyone can use the bot |
| `ATTACH_TIMEOUT_SEC` | 600 | Timeout (seconds) for `!attach bg_xxx` polling. Reads plugin option first, then env var fallback. Invalid/non-positive values fall back to 600 |

### 4. Run

```bash
opencode serve --port 4096
```

## Features

### Thread-based Sessions (persistent)
- Each Slack thread = one OpenCode session
- Session persists across server restarts (`slack-sessions.json`)
- Thread replies continue the same conversation with full context

### Multi-Agent Support
- `@build fix the bug` — use specific agent per message
- `@plan analyze this project` — plan mode
- `@oracle review this design` — read-only consultation
- No prefix → uses default or `!agent` setting

### Real-time Streaming
- 🔧 Tool execution status shown in thread
- 💭 Reasoning/thinking (when model supports it)
- 📋 Todo/plan updates forwarded to Slack

### Long Response Handling
- Responses > 3900 chars or with code blocks > 2000 chars → file upload (snippet)
- Markdown automatically converted to Slack mrkdwn format

### Permission & Question Forwarding
- Agent permission requests → forwarded to Slack thread (1/2/3 to allow/always/reject)
- Agent questions → forwarded with options, reply to answer
  - On OpenCode V2, forwarding the question to Slack works, but forwarding the Slack
    reply back does not: the V2 plugin API has no way to answer the agent's `question`
    tool. The bot tells the user to answer in the OpenCode session directly. See
    [OpenCode V2](#opencode-v2) below.

### Commands

| Command | Description |
|---------|-------------|
| `!help` | Show all commands |
| `!model` | Show current model |
| `!model provider/model` | Switch model |
| `!model reset` | Restore default model |
| `!agent` | Show current agent |
| `!agent build` | Switch agent |
| `!agent reset` | Restore default agent |
| `!dir` | Show current workspace |
| `!dir /path/to/project` | Change workspace |
| `!attach ses_xxx` | Attach existing session (URL paste supported) |
| `!attach bg_xxx` | Attach and poll a background task ID (`bg_[A-Za-z0-9_-]+`) |
| `!reset` | Reset current thread session |

## OpenCode V2

This plugin supports both OpenCode V1 and V2 from the same package, following
[OpenCode's V1/V2 dual-support pattern](https://opencode.ai/v2/docs/build/plugins/migrate-v1#support-v1-and-v2-from-one-package).
V2's server API renamed or restructured most endpoints this plugin uses, so the V1
and V2 code paths each wrap their own client and translate it into the same internal
shape; see `createV1Backend` and `createV2Backend` in `src/plugin.ts`.

Known gaps on V2:

- **Question tool replies** are not forwarded. The V2 plugin API has no
  `ctx.session.form.*` equivalent reachable from a plugin, which is what would be
  needed to answer the agent's `question` tool. Forwarding the question to Slack
  still works; answer it directly in the OpenCode session instead of replying in
  Slack.
- **Plan/todo updates** are not rendered as a dedicated checklist. V2 removed the
  `todo.updated` event; the `todo` tool now surfaces through the same generic
  tool-call events as any other tool, so its calls show up as a plain 🔧 progress
  line instead of a formatted plan.
- **`!agent`/`@agent` overrides** switch the session's agent going forward
  (`ctx.session.switchAgent`), rather than applying to only the one message, because
  V2 has no per-message agent override.

### Debug tool

`slack_test_prompt` (alongside `slack_status`) runs the same session-creation,
prompting, and turn-event handling `handleMessage` normally runs for a Slack
message, without a Slack connection. Call it with `{ "text": "..." }` from an
OpenCode session to verify the plugin against a real server; everything that would
have gone to Slack is logged to `/tmp/slack-agent-plugin.log` instead.

## Architecture

Hybrid sidecar pattern:

1. **Plugin** (runs in OpenCode's Bun runtime)
   - Manages sessions via `PluginInput.client` (no HTTP)
   - Persistent session map (JSON file)
   - Permission/question handling
   - Markdown → Slack mrkdwn conversion
   - SSE event streaming for real-time updates

2. **Socket Worker** (spawned Node.js process)
   - Maintains Slack Socket Mode WebSocket (reliable in Node)
   - Handles `chat.postMessage`, `reactions`, `files.uploadV2`
   - Communicates with plugin via IPC

This separation exists because Bun's embedded runtime doesn't reliably handle WebSocket reconnections for Socket Mode.

## Important

- Only **one** Socket Mode connection per app token at a time
- Environment variable `SLACK_AGENT_ENABLED=false` to disable without removing config

## Development

```bash
git clone https://github.com/leecoder/opencode-slack-agent.git
cd opencode-slack-agent
npm install
npm run build
```

## License

MIT
