// In-editor AI assistant: status, the optional personal proxy key and the
// streamed chat endpoint. All need the signed-in browser session.
import { API_URL, api } from "./client";
import {
  clearCsrfToken,
  ensureCsrfToken,
  fetchCsrfToken,
  getCsrfHeader,
  refreshAccessToken,
} from "./auth";
import { readSseStream } from "../utils/sse";

export type AiStatus =
  | { enabled: false }
  | {
      enabled: true;
      model: string;
      effort: string;
      personalKeysEnabled: boolean;
      sharedKeyAvailable: boolean;
      credentialAvailable: boolean;
      credentialSource: "personal" | "shared" | null;
      usingPersonalKey: boolean;
      personalKey: { hint: string; validatedAt: string } | null;
      personalKeyUnreadable: boolean;
      /** Why no credential is available, when none is. */
      message: string | null;
      /** Models the effective key may use, or null when unknown. */
      models: string[] | null;
      modelAvailable: boolean | null;
      modelsError: string | null;
    };

export type EnabledAiStatus = Extract<AiStatus, { enabled: true }>;

export const getAiStatus = async (): Promise<AiStatus> => {
  const response = await api.get<AiStatus>("/auth/ai/status");
  return response.data;
};

export const saveAiKey = async (key: string): Promise<AiStatus> => {
  const response = await api.put<AiStatus>("/auth/ai/key", { key });
  return response.data;
};

export const removeAiKey = async (): Promise<AiStatus> => {
  const response = await api.delete<AiStatus>("/auth/ai/key");
  return response.data;
};

export type AgentChatTurn = { role: "user" | "assistant"; content: string };

export type AgentViewport = {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom: number;
};

export type AgentChatRequest = {
  drawingId: string;
  messages: AgentChatTurn[];
  message: string;
  context: { selectedElementIds?: string[]; viewport?: AgentViewport };
};

export type AgentChatEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; summary: string; isError: boolean }
  | {
      type: "done";
      outcome?: string;
      stopReason?: string | null;
      changedDrawing?: boolean;
      usage?: Record<string, number>;
    }
  | { type: "error"; code?: string; message: string };

/** Limits mirrored from the backend (POST /agent/chat). */
export const AGENT_CHAT_LIMITS = {
  maxHistoryTurns: 40,
  maxTurnChars: 16_000,
  maxHistoryChars: 60_000,
  maxMessageChars: 8_000,
  maxSelectedIds: 500,
};

export class AgentChatError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "AgentChatError";
    this.status = status;
    this.code = code;
  }
}

/** Keep the newest turns that fit the backend's history limits. */
export const trimChatHistory = (turns: AgentChatTurn[]): AgentChatTurn[] => {
  const kept: AgentChatTurn[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const content = turns[i].content.slice(0, AGENT_CHAT_LIMITS.maxTurnChars);
    if (!content.trim()) continue;
    if (
      kept.length >= AGENT_CHAT_LIMITS.maxHistoryTurns ||
      total + content.length > AGENT_CHAT_LIMITS.maxHistoryChars
    ) {
      break;
    }
    total += content.length;
    kept.unshift({ role: turns[i].role, content });
  }
  while (kept.length > 0 && kept[0].role !== "user") kept.shift();
  return kept;
};

const toChatEvent = (event: string, raw: string): AgentChatEvent | null => {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  switch (event) {
    case "text":
      return typeof data.text === "string"
        ? { type: "text", text: data.text }
        : null;
    case "tool":
      return {
        type: "tool",
        name: String(data.name ?? ""),
        summary: String(data.summary ?? data.name ?? ""),
        isError: data.isError === true,
      };
    case "done":
      return { type: "done", ...data };
    case "error":
      return {
        type: "error",
        code: typeof data.code === "string" ? data.code : undefined,
        message:
          typeof data.message === "string"
            ? data.message
            : "The assistant failed.",
      };
    default:
      return null;
  }
};

/**
 * POST /agent/chat and stream its Server-Sent Events. Uses fetch (axios cannot
 * stream in the browser) with the same session cookies and CSRF header as the
 * axios client, retrying once after a token refresh or a stale CSRF token.
 */
export const streamAgentChat = async (
  request: AgentChatRequest,
  {
    signal,
    onEvent,
  }: { signal?: AbortSignal; onEvent: (event: AgentChatEvent) => void },
): Promise<void> => {
  const send = async () => {
    await ensureCsrfToken();
    const csrf = getCsrfHeader();
    return fetch(`${API_URL}/agent/chat`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(csrf ? { [csrf.name]: csrf.token } : {}),
      },
      body: JSON.stringify(request),
      signal,
    });
  };

  let response = await send();
  if (response.status === 401) {
    try {
      await refreshAccessToken();
      response = await send();
    } catch {
      // Fall through with the 401 below.
    }
  } else if (response.status === 403) {
    const body = await response
      .clone()
      .json()
      .catch(() => null);
    if (typeof body?.error === "string" && body.error.includes("CSRF")) {
      clearCsrfToken();
      await fetchCsrfToken();
      response = await send();
    }
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (
    !response.ok ||
    !response.body ||
    !contentType.includes("text/event-stream")
  ) {
    const body = await response.json().catch(() => null);
    const message =
      typeof body?.message === "string"
        ? body.message
        : response.status === 401
          ? "Your session has expired. Sign in again."
          : `The assistant request failed (HTTP ${response.status}).`;
    throw new AgentChatError(
      message,
      response.status,
      typeof body?.code === "string" ? body.code : undefined,
    );
  }

  await readSseStream(response.body, ({ event, data }) => {
    const parsed = toChatEvent(event, data);
    if (parsed) onEvent(parsed);
  });
};
