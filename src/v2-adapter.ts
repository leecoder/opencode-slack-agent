// Pure, dependency-free helpers that bridge OpenCode V2 server API shapes to the
// legacy `{ info: { id, role, time }, parts: [...] }` shape this plugin's V1 logic
// was written against. Isolating the mapping here keeps it unit-testable without
// a running OpenCode server, a Slack connection, or any plugin runtime.

export interface LegacyMessagePart {
  type: "text";
  text: string;
}

export interface LegacyMessage {
  info: {
    id: string;
    role: string;
    time: { created: number; streamed?: number; completed?: number };
  };
  parts: LegacyMessagePart[];
}

/** Minimal shape of a Session.Message.Info union member, as returned by `GET /api/session/{id}/context`. */
export interface V2SessionMessage {
  id: string;
  type: string;
  time?: { created: number; streamed?: number; completed?: number };
  text?: string;
  content?: Array<{ type: string; text?: string }>;
}

export function mapSessionMessageToLegacyShape(message: V2SessionMessage): LegacyMessage {
  const time = message.time ?? { created: 0 };
  const info = { id: message.id, role: message.type, time };

  if (message.type === "user" && typeof message.text === "string") {
    return { info, parts: message.text ? [{ type: "text", text: message.text }] : [] };
  }

  if (message.type === "assistant" && Array.isArray(message.content)) {
    const parts: LegacyMessagePart[] = message.content
      .filter((item) => item.type === "text" && typeof item.text === "string" && item.text)
      .map((item) => ({ type: "text", text: item.text as string }));
    return { info, parts };
  }

  return { info, parts: [] };
}
