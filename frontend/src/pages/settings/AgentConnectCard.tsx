import React, { useState } from "react";
import { Bot, Copy } from "lucide-react";
import * as api from "../../api";
import { APP_NAME } from "../../branding";
import { copyTextToClipboard } from "../../utils/clipboard";
import {
  AGENT_API_KEY_ENV_VAR,
  AGENT_API_KEY_NAME,
  AGENT_READ_ONLY_API_KEY_NAME,
  AGENT_READ_ONLY_SCOPES,
  buildAgentCommands,
} from "../../utils/agentConnect";
import {
  SettingsCard,
  SettingsSectionHeader,
  settingsButtonClass,
} from "./SettingsRow";

type AgentTab = "claude" | "codex";

const AGENT_TABS: { id: AgentTab; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

const getApiErrorMessage = (err: unknown, fallback: string) => {
  if (api.isAxiosError(err)) {
    if (err.response?.data?.message) return err.response.data.message;
    if (err.response?.data?.error) return err.response.data.error;
  }
  return fallback;
};

type Props = {
  disabled: boolean;
  onSuccess: (message: string) => void;
  /** Called after a key is created so the API keys list can refresh. */
  onKeyCreated?: () => void;
};

export const AgentConnectCard: React.FC<Props> = ({
  disabled,
  onSuccess,
  onKeyCreated,
}) => {
  const [readOnly, setReadOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [token, setToken] = useState("");
  const [tokenReadOnly, setTokenReadOnly] = useState(false);
  const [tab, setTab] = useState<AgentTab>("claude");
  const [copied, setCopied] = useState(false);

  const commands = buildAgentCommands(window.location.origin, token);
  const command = tab === "claude" ? commands.claudeCode : commands.codex;

  const handleCreate = async () => {
    if (disabled || creating) return;
    setCreating(true);
    setError("");
    onSuccess("");
    try {
      const response = await api.createApiKey(
        readOnly ? AGENT_READ_ONLY_API_KEY_NAME : AGENT_API_KEY_NAME,
        readOnly ? AGENT_READ_ONLY_SCOPES : [...api.API_KEY_SCOPES],
      );
      setToken(response.token);
      setTokenReadOnly(readOnly);
      setCopied(false);
      onKeyCreated?.();
      onSuccess(
        "AI agent key created. Copy the command now; the key will not be shown again.",
      );
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, "Failed to create API key"));
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    try {
      await copyTextToClipboard(command);
      setCopied(true);
      onSuccess("Command copied to clipboard");
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Failed to copy the command. Select and copy it manually.");
    }
  };

  const dismissToken = () => {
    setToken("");
    setTokenReadOnly(false);
    setCopied(false);
  };

  return (
    <section>
      <SettingsSectionHeader
        icon={<Bot size={20} />}
        tileClassName="border-black bg-violet-300 text-black dark:border-neutral-700 dark:bg-violet-300 dark:text-black"
        title="Connect an AI agent"
        subtitle={`Let Claude Code or Codex work with your ${APP_NAME} drawings`}
      />
      {disabled ? (
        <div className="p-3.5 bg-amber-50 dark:bg-amber-950 border-2 border-amber-200 dark:border-amber-800 rounded-xl">
          <p className="text-amber-900 dark:text-amber-200 font-bold">
            Connecting an AI agent is unavailable until you reset your password.
          </p>
        </div>
      ) : (
        <>
          {error && (
            <div className="mb-3 p-3.5 bg-red-50 dark:bg-red-950 border-2 border-red-200 dark:border-red-800 rounded-xl">
              <p className="text-red-800 dark:text-red-200 font-medium">
                {error}
              </p>
            </div>
          )}
          <SettingsCard>
            <div className="px-4 py-3.5 sm:px-5">
              <p className="text-sm font-medium text-slate-700 dark:text-neutral-300">
                {APP_NAME} is an MCP server: an AI agent connected to it can
                list, read, create and edit your drawings (it cannot delete
                drawings or change sharing). Create an API key for the agent,
                then run the command for your agent in a terminal.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <label className="flex items-center gap-2 rounded-lg border-2 border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                  <input
                    type="checkbox"
                    checked={readOnly}
                    onChange={(event) => setReadOnly(event.target.checked)}
                    className="h-3.5 w-3.5 accent-emerald-600"
                  />
                  <span>Read-only (the agent can view but not edit)</span>
                </label>
                <button
                  onClick={() => void handleCreate()}
                  disabled={creating}
                  className="ui-button-primary ml-auto"
                >
                  {creating ? "Creating..." : "Create key"}
                </button>
              </div>
            </div>

            {token && (
              <div
                className="border-l-4 border-amber-500 bg-slate-50 px-4 py-3.5 dark:bg-neutral-800 sm:px-5"
                aria-live="polite"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="text-slate-900 dark:text-white font-bold">
                      Copy the command now. The key will not be shown again.
                    </p>
                    <p className="text-xs text-slate-600 dark:text-neutral-300 font-medium mt-0.5">
                      The commands below contain your new{" "}
                      {tokenReadOnly ? "read-only " : ""}key.
                    </p>
                  </div>
                  <button
                    onClick={dismissToken}
                    className={settingsButtonClass}
                  >
                    Done
                  </button>
                </div>
              </div>
            )}

            <div className="px-4 py-3.5 sm:px-5">
              <div
                role="tablist"
                aria-label="AI agent"
                className="flex flex-wrap gap-2"
              >
                {AGENT_TABS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    id={`agent-tab-${entry.id}`}
                    aria-selected={tab === entry.id}
                    aria-controls="agent-command-panel"
                    onClick={() => {
                      setTab(entry.id);
                      setCopied(false);
                    }}
                    className={
                      tab === entry.id
                        ? "ui-button-primary"
                        : settingsButtonClass
                    }
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
              <div
                id="agent-command-panel"
                role="tabpanel"
                aria-labelledby={`agent-tab-${tab}`}
                className="mt-3"
              >
                {tab === "codex" ? (
                  <p className="mb-2 text-xs font-medium text-slate-500 dark:text-neutral-400">
                    Add the <code>export {AGENT_API_KEY_ENV_VAR}=…</code> line
                    to your shell profile (e.g. <code>~/.zshrc</code>) so Codex
                    finds the key in new terminals.
                  </p>
                ) : (
                  <p className="mb-2 text-xs font-medium text-slate-500 dark:text-neutral-400">
                    Registers the server for all your projects; check it with{" "}
                    <code>claude mcp list</code>.
                  </p>
                )}
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                  <pre
                    aria-label={`${tab === "claude" ? "Claude Code" : "Codex"} command`}
                    className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border-2 border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                  >
                    {command}
                  </pre>
                  <button
                    onClick={() => void handleCopy()}
                    aria-label="Copy command"
                    className="ui-button-primary shrink-0"
                  >
                    <Copy size={14} />
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
              <p className="mt-3 text-xs font-medium text-slate-500 dark:text-neutral-400">
                {token
                  ? "Keep this key secret. "
                  : "Replace <your-api-key> with a key, or create one above. "}
                You can revoke agent keys at any time in the API keys list
                above.
              </p>
            </div>
          </SettingsCard>
        </>
      )}
    </section>
  );
};
