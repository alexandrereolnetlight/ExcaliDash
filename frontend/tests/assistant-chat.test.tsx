import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  ensureCsrfToken: vi.fn(async () => undefined),
  getCsrfHeader: vi.fn(() => ({ name: "x-csrf-token", token: "csrf-123" })),
  clearCsrfToken: vi.fn(),
  fetchCsrfToken: vi.fn(async () => undefined),
  refreshAccessToken: vi.fn(async () => undefined),
}));
vi.mock("../src/api/auth", () => auth);

import { AssistantPanel } from "../src/components/assistant/AssistantPanel";
import { useAssistantChat } from "../src/components/assistant/useAssistantChat";
import type { AgentChatRequest, EnabledAiStatus } from "../src/api/ai";

// The editor owns the conversation (the sidebar unmounts when closed); this
// harness mirrors EditorView, and can hide the panel like a closed sidebar.
const Harness = ({
  status,
  isAdmin,
  getContext,
  panelOpen = true,
}: {
  status: EnabledAiStatus;
  isAdmin: boolean;
  getContext: () => AgentChatRequest["context"];
  panelOpen?: boolean;
}) => {
  const chat = useAssistantChat({
    drawingId: "drawing-1",
    canChat: status.credentialAvailable,
    getContext,
  });
  return panelOpen ? (
    <AssistantPanel chat={chat} status={status} isAdmin={isAdmin} />
  ) : null;
};

const STATUS: EnabledAiStatus = {
  enabled: true,
  model: "claude-opus-5-5",
  effort: "medium",
  personalKeysEnabled: true,
  sharedKeyAvailable: true,
  credentialAvailable: true,
  credentialSource: "shared",
  usingPersonalKey: false,
  personalKey: null,
  personalKeyUnreadable: false,
  message: null,
  models: ["claude-opus-5-5"],
  modelAvailable: true,
  modelsError: null,
};

const CONTEXT = {
  selectedElementIds: ["rect-1"],
  viewport: { x: 0, y: 0, width: 800, height: 600, zoom: 1 },
};

const sseResponse = (events: Array<[string, unknown]>) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      for (const [event, data] of events) {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
};

const textOf = (renderer: ReactTestRenderer): string => {
  const collect = (node: unknown): string => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(collect).join("");
    if (!node || typeof node !== "object") return "";
    const children = (node as { children?: unknown[] }).children ?? [];
    return children.map(collect).join("");
  };
  return collect(renderer.toJSON());
};

const buttonText = (node: any): string =>
  node.children
    .map((child: any) => (typeof child === "string" ? child : ""))
    .join("");

const button = (renderer: ReactTestRenderer, label: string) =>
  renderer.root
    .findAllByType("button")
    .find((node) => buttonText(node).includes(label))!;

const render = async (status: EnabledAiStatus = STATUS, isAdmin = false) => {
  const getContext = vi.fn(() => CONTEXT);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <MemoryRouter>
        <Harness status={status} isAdmin={isAdmin} getContext={getContext} />
      </MemoryRouter>,
    );
  });
  const setPanelOpen = async (panelOpen: boolean) => {
    await act(async () => {
      renderer.update(
        <MemoryRouter>
          <Harness
            status={status}
            isAdmin={isAdmin}
            getContext={getContext}
            panelOpen={panelOpen}
          />
        </MemoryRouter>,
      );
    });
  };
  return { renderer, getContext, setPanelOpen };
};

const type = async (renderer: ReactTestRenderer, value: string) => {
  await act(async () => {
    renderer.root.findByType("textarea").props.onChange({ target: { value } });
  });
};

const pressEnter = async (renderer: ReactTestRenderer, shiftKey = false) => {
  const preventDefault = vi.fn();
  await act(async () => {
    renderer.root.findByType("textarea").props.onKeyDown({
      key: "Enter",
      shiftKey,
      preventDefault,
      nativeEvent: { isComposing: false },
    });
  });
  return preventDefault;
};

describe("assistant chat panel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the message with context and history, then streams the reply", async () => {
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([
          ["text", { text: "I'll add " }],
          [
            "tool",
            {
              name: "get_drawing",
              summary: "Read the drawing (1 element)",
              isError: false,
            },
          ],
          [
            "tool",
            {
              name: "update_drawing",
              summary: "Added 2 elements",
              isError: false,
            },
          ],
          ["text", { text: "a box." }],
          ["done", { outcome: "completed", changedDrawing: true }],
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          ["text", { text: "Sure." }],
          ["done", { outcome: "completed" }],
        ]),
      );
    const { renderer, getContext } = await render();
    expect(textOf(renderer)).toContain("Ask me to add, rearrange or explain");

    await type(renderer, "Add a box");
    // Shift+Enter is a new line, not a send.
    const shiftPrevent = await pressEnter(renderer, true);
    expect(shiftPrevent).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    const prevent = await pressEnter(renderer);
    expect(prevent).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/agent/chat");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.headers["x-csrf-token"]).toBe("csrf-123");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({
      drawingId: "drawing-1",
      messages: [],
      message: "Add a box",
      context: CONTEXT,
    });
    expect(getContext).toHaveBeenCalledTimes(1);

    const text = textOf(renderer);
    expect(text).toContain("Add a box");
    expect(text).toContain("I'll add a box.");
    expect(text).toContain("Read the drawing (1 element)");
    expect(text).toContain("Added 2 elements");
    expect(renderer.root.findByType("textarea").props.value).toBe("");

    await type(renderer, "Thanks");
    await act(async () => {
      button(renderer, "Send").props.onClick();
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages).toEqual([
      { role: "user", content: "Add a box" },
      { role: "assistant", content: "I'll add a box." },
    ]);
    expect(textOf(renderer)).toContain("Sure.");

    // Clear empties the conversation.
    await act(async () => {
      button(renderer, "Clear").props.onClick();
    });
    expect(textOf(renderer)).not.toContain("Add a box");
    expect(textOf(renderer)).toContain("Ask me to add, rearrange or explain");
  });

  it("keeps the conversation and a running reply while the sidebar is closed", async () => {
    let finish!: () => void;
    fetchMock.mockImplementationOnce(async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode('event: text\ndata: {"text":"Part one. "}\n\n'),
          );
          finish = () => {
            controller.enqueue(
              encoder.encode('event: text\ndata: {"text":"Part two."}\n\n'),
            );
            controller.close();
          };
        },
      });
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const { renderer, setPanelOpen } = await render();
    await type(renderer, "Explain");
    let pending!: Promise<void>;
    act(() => {
      pending = Promise.resolve(button(renderer, "Send").props.onClick());
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(textOf(renderer)).toContain("Part one.");
    await setPanelOpen(false);
    expect(renderer.toJSON()).toBeNull();
    await act(async () => {
      finish();
      await pending;
    });
    await setPanelOpen(true);
    const text = textOf(renderer);
    expect(text).toContain("Explain");
    expect(text).toContain("Part one. Part two.");
    expect(text).not.toContain("Stopped.");
  });

  it("shows error events and HTTP errors inline", async () => {
    fetchMock
      .mockResolvedValueOnce(
        sseResponse([
          [
            "error",
            { code: "key_rejected", message: "Your key was rejected." },
          ],
        ]),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "read_only",
            message: "You only have view access to this drawing.",
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      );
    const { renderer } = await render();
    await type(renderer, "Hello");
    await pressEnter(renderer);
    expect(textOf(renderer)).toContain("Your key was rejected.");
    await type(renderer, "Again");
    await pressEnter(renderer);
    expect(textOf(renderer)).toContain(
      "You only have view access to this drawing.",
    );
    // Failed turns are not sent back as history.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops a running request", async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const { renderer } = await render();
    await type(renderer, "Draw a lot");
    let pending!: Promise<void>;
    act(() => {
      pending = Promise.resolve(button(renderer, "Send").props.onClick());
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(textOf(renderer)).toContain("Working…");
    await act(async () => {
      button(renderer, "Stop").props.onClick();
      await pending;
    });
    expect(textOf(renderer)).toContain("Stopped.");
    expect(button(renderer, "Send")).toBeDefined();
  });

  it("explains a missing key and disables the input", async () => {
    const { renderer } = await render(
      {
        ...STATUS,
        credentialAvailable: false,
        credentialSource: null,
        sharedKeyAvailable: false,
        message: "The AI assistant has no API key to use.",
      },
      true,
    );
    const text = textOf(renderer);
    expect(text).toContain("The AI assistant has no API key to use.");
    expect(text).toContain("AI_PROXY_API_KEY");
    expect(text).toContain("Settings");
    expect(renderer.root.findByType("textarea").props.disabled).toBe(true);
  });
});
