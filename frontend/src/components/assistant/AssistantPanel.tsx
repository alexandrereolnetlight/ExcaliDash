import React, { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import clsx from "clsx";
import { AlertTriangle, Eraser, Send, Square, Wrench } from "lucide-react";
import { AGENT_CHAT_LIMITS, type EnabledAiStatus } from "../../api/ai";
import { APP_NAME } from "../../branding";
import type { AssistantChat } from "./useAssistantChat";

type AssistantPanelProps = {
  chat: AssistantChat;
  status: EnabledAiStatus;
  isAdmin: boolean;
};

export const AssistantPanel: React.FC<AssistantPanelProps> = ({
  chat,
  status,
  isAdmin,
}) => {
  const { messages, input, setInput, isStreaming, send, stop, clear } = chat;
  const listRef = useRef<HTMLDivElement | null>(null);
  const canChat = status.credentialAvailable;

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent?.isComposing
    ) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col text-sm text-slate-800 dark:text-neutral-200">
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-neutral-700 dark:text-neutral-400">
        <span className="min-w-0 flex-1 truncate" title={status.model}>
          {status.usingPersonalKey
            ? `Your key · ${status.model}`
            : status.model}
        </span>
        <button
          type="button"
          onClick={clear}
          disabled={messages.length === 0}
          className="flex items-center gap-1 rounded-md px-2 py-1 font-medium hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-neutral-800"
          title="Clear the conversation"
        >
          <Eraser size={14} />
          Clear
        </button>
      </div>

      <div
        ref={listRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
        aria-live="polite"
      >
        {!canChat ? (
          <div
            role="alert"
            className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          >
            <p className="font-semibold">The assistant is not set up yet.</p>
            <p className="mt-1">{status.message}</p>
            {isAdmin ? (
              <p className="mt-1">
                As an administrator, set AI_PROXY_API_KEY on the server to give
                everyone a shared key.
              </p>
            ) : null}
            {status.personalKeysEnabled ? (
              <p className="mt-1">
                You can add your own Netlight AI key in{" "}
                <Link to="/settings" className="font-semibold underline">
                  Settings
                </Link>
                .
              </p>
            ) : null}
          </div>
        ) : messages.length === 0 ? (
          <p className="text-slate-500 dark:text-neutral-400">
            Ask me to add, rearrange or explain things in this drawing. I can
            see which elements you have selected. Changes are saved to the
            drawing and can be undone from the History panel.
          </p>
        ) : null}

        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-indigo-600 px-3 py-2 text-white">
                {message.text}
              </div>
            </div>
          ) : (
            <div
              key={message.id}
              className="space-y-1.5"
              data-testid="assistant-message"
            >
              {message.tools.map((tool, index) => (
                <div
                  key={index}
                  className={clsx(
                    "flex items-center gap-1.5 text-xs",
                    tool.isError
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-slate-500 dark:text-neutral-400",
                  )}
                >
                  {tool.isError ? (
                    <AlertTriangle size={12} />
                  ) : (
                    <Wrench size={12} />
                  )}
                  <span>{tool.summary}</span>
                </div>
              ))}
              {message.text ? (
                <div className="whitespace-pre-wrap break-words">
                  {message.text}
                </div>
              ) : null}
              {message.streaming && !message.text ? (
                <div className="animate-pulse text-xs text-slate-500 dark:text-neutral-400">
                  Working…
                </div>
              ) : null}
              {message.stopped ? (
                <div className="text-xs italic text-slate-500 dark:text-neutral-400">
                  Stopped.
                </div>
              ) : null}
              {message.error ? (
                <div
                  role="alert"
                  className="rounded-md bg-rose-50 px-2 py-1.5 text-xs text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                >
                  {message.error}
                </div>
              ) : null}
            </div>
          ),
        )}
      </div>

      <div className="border-t border-slate-200 p-2 dark:border-neutral-700">
        <textarea
          aria-label={`Message the ${APP_NAME} assistant`}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={!canChat}
          maxLength={AGENT_CHAT_LIMITS.maxMessageChars}
          rows={3}
          placeholder="Ask the assistant… (Enter to send, Shift+Enter for a new line)"
          className="w-full resize-none rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm outline-none focus:border-indigo-500 disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-900"
        />
        <div className="mt-1.5 flex justify-end">
          {isStreaming ? (
            <button
              type="button"
              onClick={stop}
              className="flex items-center gap-1.5 rounded-lg bg-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-300 dark:bg-neutral-700 dark:text-neutral-100"
            >
              <Square size={12} />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void send()}
              disabled={!canChat || !input.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-40"
            >
              <Send size={12} />
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
