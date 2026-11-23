import { describe, expect, it } from "vitest";
import {
  createSseParser,
  readSseStream,
  type SseMessage,
} from "../src/utils/sse";
import { trimChatHistory, AGENT_CHAT_LIMITS } from "../src/api/ai";
import { buildAssistantContext } from "../src/components/assistant/assistantContext";

const collect = (chunks: string[], end = true) => {
  const messages: SseMessage[] = [];
  const parser = createSseParser((message) => messages.push(message));
  for (const chunk of chunks) parser.feed(chunk);
  if (end) parser.end();
  return messages;
};

describe("SSE parser", () => {
  it("parses named events and skips comment pings", () => {
    expect(
      collect([
        ": connected\n\n",
        'event: text\ndata: {"text":"Hi"}\n\n',
        ": ping\n\n",
        'event: done\ndata: {"outcome":"completed"}\n\n',
      ]),
    ).toEqual([
      { event: "text", data: '{"text":"Hi"}' },
      { event: "done", data: '{"outcome":"completed"}' },
    ]);
  });

  it("handles events split across chunks at any position", () => {
    const stream =
      'event: text\ndata: {"text":"a"}\n\nevent: tool\ndata: {"name":"x"}\n\n';
    for (let cut = 1; cut < stream.length; cut++) {
      expect(collect([stream.slice(0, cut), stream.slice(cut)])).toEqual([
        { event: "text", data: '{"text":"a"}' },
        { event: "tool", data: '{"name":"x"}' },
      ]);
    }
  });

  it("supports CRLF and CR line endings, including a CRLF split across chunks", () => {
    expect(
      collect(["event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\r"]),
    ).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
    expect(collect(["event: a\r", "\ndata: 1\r", "\n\r", "\n"])).toEqual([
      { event: "a", data: "1" },
    ]);
  });

  it("joins multi-line data, defaults the event name and strips one leading space", () => {
    expect(collect(["data:  two spaces\ndata:line2\n\n"])).toEqual([
      { event: "message", data: " two spaces\nline2" },
    ]);
  });

  it("ignores events without data and flushes a trailing event on end", () => {
    expect(collect(["event: empty\n\n", "event: last\ndata: x"])).toEqual([
      { event: "last", data: "x" },
    ]);
    expect(collect(["event: last\ndata: x"], false)).toEqual([]);
  });

  it("reads a fetch body stream with multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode(
      'event: text\ndata: {"text":"Grüße 👋"}\n\n',
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) {
          controller.enqueue(bytes.slice(i, i + 3));
        }
        controller.close();
      },
    });
    const messages: SseMessage[] = [];
    await readSseStream(body, (message) => messages.push(message));
    expect(messages).toEqual([{ event: "text", data: '{"text":"Grüße 👋"}' }]);
  });
});

describe("assistant request helpers", () => {
  it("keeps the newest turns within the limits, starting with a user turn", () => {
    const turns = Array.from({ length: 60 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `turn ${i}`,
    }));
    const trimmed = trimChatHistory(turns);
    expect(trimmed.length).toBeLessThanOrEqual(
      AGENT_CHAT_LIMITS.maxHistoryTurns,
    );
    expect(trimmed[0].role).toBe("user");
    expect(trimmed.at(-1)?.content).toBe("turn 59");
    const big = trimChatHistory([
      { role: "user", content: "x".repeat(15_000) },
      { role: "assistant", content: "y".repeat(15_000) },
      { role: "user", content: "z".repeat(15_000) },
      { role: "assistant", content: "w".repeat(15_000) },
      { role: "user", content: "v".repeat(15_000) },
    ]);
    expect(big.reduce((sum, turn) => sum + turn.content.length, 0)).toBe(
      45_000,
    );
    expect(big[0].role).toBe("user");
  });

  it("builds selection and scene-space viewport from the app state", () => {
    expect(
      buildAssistantContext({
        selectedElementIds: { a: true, b: false, c: true },
        scrollX: -100,
        scrollY: 50,
        width: 1000,
        height: 800,
        zoom: { value: 2 },
      }),
    ).toEqual({
      selectedElementIds: ["a", "c"],
      viewport: { x: 100, y: -50, width: 500, height: 400, zoom: 2 },
    });
    expect(buildAssistantContext({ selectedElementIds: {} })).toEqual({
      selectedElementIds: [],
    });
    expect(buildAssistantContext(null)).toEqual({});
  });
});
