import { describe, expect, test } from "bun:test";
import { mapSessionMessageToLegacyShape } from "../src/v2-adapter";

describe("mapSessionMessageToLegacyShape", () => {
  test("maps a V2 user message to the legacy {info, parts} shape", () => {
    const v2Message = {
      id: "msg_user1",
      type: "user" as const,
      time: { created: 1000 },
      text: "hello there",
    };

    const result = mapSessionMessageToLegacyShape(v2Message);

    expect(result).toEqual({
      info: { id: "msg_user1", role: "user", time: { created: 1000 } },
      parts: [{ type: "text", text: "hello there" }],
    });
  });

  test("maps a V2 assistant message, keeping only text content items", () => {
    const v2Message = {
      id: "msg_asst1",
      type: "assistant" as const,
      time: { created: 1000, completed: 2000 },
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet-5" },
      content: [
        { type: "reasoning", text: "thinking..." },
        { type: "text", text: "part one" },
        { type: "tool", id: "call_1", name: "read", state: { status: "completed" }, time: {} },
        { type: "text", text: "part two" },
      ],
    };

    const result = mapSessionMessageToLegacyShape(v2Message);

    expect(result).toEqual({
      info: { id: "msg_asst1", role: "assistant", time: { created: 1000, completed: 2000 } },
      parts: [
        { type: "text", text: "part one" },
        { type: "text", text: "part two" },
      ],
    });
  });

  test("returns no parts for an assistant message with no text content", () => {
    const v2Message = {
      id: "msg_asst2",
      type: "assistant" as const,
      time: { created: 1000 },
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet-5" },
      content: [{ type: "tool", id: "call_1", name: "read", state: { status: "completed" }, time: {} }],
    };

    const result = mapSessionMessageToLegacyShape(v2Message);

    expect(result.parts).toEqual([]);
  });

  test("falls back to an empty-parts shape for message types without text or content", () => {
    const v2Message = {
      id: "msg_sys1",
      type: "system" as const,
      time: { created: 1000 },
    };

    const result = mapSessionMessageToLegacyShape(v2Message);

    expect(result).toEqual({
      info: { id: "msg_sys1", role: "system", time: { created: 1000 } },
      parts: [],
    });
  });
});
