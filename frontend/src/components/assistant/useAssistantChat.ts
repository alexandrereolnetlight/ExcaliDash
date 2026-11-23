import { useCallback, useEffect, useRef, useState } from "react";
import {
  AGENT_CHAT_LIMITS,
  AgentChatError,
  streamAgentChat,
  trimChatHistory,
  type AgentChatRequest,
} from "../../api/ai";

export type AssistantToolActivity = {
  name: string;
  summary: string;
  isError: boolean;
};

export type AssistantChatMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
  tools: AssistantToolActivity[];
  error?: string;
  streaming?: boolean;
  stopped?: boolean;
};

export type AssistantChat = {
  messages: AssistantChatMessage[];
  input: string;
  setInput: (value: string) => void;
  isStreaming: boolean;
  send: () => Promise<void>;
  stop: () => void;
  clear: () => void;
};

const isAbortError = (error: unknown) =>
  (error as { name?: string } | null)?.name === "AbortError";

/**
 * Conversation state for the assistant. It lives with the editor rather than
 * the sidebar (Excalidraw unmounts a closed sidebar's content), so closing the
 * sidebar keeps the conversation and a running request; it is dropped when
 * the editor unmounts, i.e. on reload or when another drawing opens.
 */
export const useAssistantChat = ({
  drawingId,
  canChat,
  getContext,
}: {
  drawingId: string;
  canChat: boolean;
  /** Selection and viewport at the moment a message is sent. */
  getContext: () => AgentChatRequest["context"];
}): AssistantChat => {
  const [messages, setMessages] = useState<AssistantChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const nextIdRef = useRef(1);

  useEffect(() => () => abortRef.current?.abort(), []);

  const updateMessage = useCallback(
    (
      id: number,
      update: (message: AssistantChatMessage) => AssistantChatMessage,
    ) =>
      setMessages((current) =>
        current.map((message) =>
          message.id === id ? update(message) : message,
        ),
      ),
    [],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming || !canChat || !drawingId) return;
    const history = trimChatHistory(
      messages
        .filter((message) => !message.error && message.text.trim())
        .map((message) => ({ role: message.role, content: message.text })),
    );
    const userId = nextIdRef.current++;
    const assistantId = nextIdRef.current++;
    setMessages((current) => [
      ...current,
      { id: userId, role: "user", text, tools: [] },
      {
        id: assistantId,
        role: "assistant",
        text: "",
        tools: [],
        streaming: true,
      },
    ]);
    setInput("");
    setIsStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamAgentChat(
        {
          drawingId,
          messages: history,
          message: text.slice(0, AGENT_CHAT_LIMITS.maxMessageChars),
          context: getContext(),
        },
        {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === "text") {
              updateMessage(assistantId, (message) => ({
                ...message,
                text: message.text + event.text,
              }));
            } else if (event.type === "tool") {
              updateMessage(assistantId, (message) => ({
                ...message,
                tools: [
                  ...message.tools,
                  {
                    name: event.name,
                    summary: event.summary,
                    isError: event.isError,
                  },
                ],
              }));
            } else if (event.type === "error") {
              updateMessage(assistantId, (message) => ({
                ...message,
                error: event.message,
              }));
            }
          },
        },
      );
    } catch (error) {
      updateMessage(assistantId, (message) =>
        isAbortError(error)
          ? { ...message, stopped: true }
          : {
              ...message,
              error:
                error instanceof AgentChatError
                  ? error.message
                  : "Could not reach the assistant. Check your connection and try again.",
            },
      );
    } finally {
      updateMessage(assistantId, (message) => ({
        ...message,
        streaming: false,
      }));
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsStreaming(false);
      }
    }
  }, [
    canChat,
    drawingId,
    getContext,
    input,
    isStreaming,
    messages,
    updateMessage,
  ]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setMessages([]);
  }, []);

  return { messages, input, setInput, isStreaming, send, stop, clear };
};
