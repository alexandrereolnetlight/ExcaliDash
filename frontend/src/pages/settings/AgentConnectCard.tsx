import React, { useCallback, useEffect, useState } from "react";
import { Bot, Copy, Trash2 } from "lucide-react";
import * as api from "../../api";
import { APP_NAME } from "../../branding";
import { ConfirmModal } from "../../components/ConfirmModal";
import { copyTextToClipboard } from "../../utils/clipboard";
import {
  AGENT_API_KEY_ENV_VAR,
  AGENT_API_KEY_NAME,
  AGENT_READ_ONLY_API_KEY_NAME,
  AGENT_READ_ONLY_SCOPES,
  buildAgentCommands,
  buildApiKeyAgentCommands,
  describeAgentAccess,
  MCP_SERVER_NAME,
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

const formatDate = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Never";

const codeBlockClass =
  "min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border-2 border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200";
const hintClass = "text-xs font-medium text-slate-500 dark:text-neutral-400";

const CommandBlock: React.FC<{
  label: string;
  command: string;
  onCopy: (command: string) => void;
  copied: boolean;
}> = ({ label, command, onCopy, copied }) => (
  <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
    <pre aria-label={label} className={codeBlockClass}>
      {command}
    </pre>
    <button
      onClick={() => onCopy(command)}
      aria-label={`Copy ${label}`}
      className="ui-button-primary shrink-0"
    >
      <Copy size={14} />
      {copied ? "Copied" : "Copy"}
    </button>
  </div>
);

const AgentTabs: React.FC<{
  idPrefix: string;
  tab: AgentTab;
  onChange: (tab: AgentTab) => void;
}> = ({ idPrefix, tab, onChange }) => (
  <div role="tablist" aria-label="AI agent" className="flex flex-wrap gap-2">
    {AGENT_TABS.map((entry) => (
      <button
        key={entry.id}
        type="button"
        role="tab"
        id={`${idPrefix}-tab-${entry.id}`}
        aria-selected={tab === entry.id}
        aria-controls={`${idPrefix}-panel`}
        onClick={() => onChange(entry.id)}
        className={tab === entry.id ? "ui-button-primary" : settingsButtonClass}
      >
        {entry.label}
      </button>
    ))}
  </div>
);

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
  const [error, setError] = useState("");
  const [tab, setTab] = useState<AgentTab>("claude");
  const [copiedCommand, setCopiedCommand] = useState("");

  // Connected agents (OAuth grants)
  const [grants, setGrants] = useState<api.OAuthGrant[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [grantToRevoke, setGrantToRevoke] = useState<api.OAuthGrant | null>(
    null,
  );
  const [revoking, setRevoking] = useState(false);

  // Advanced: API key fallback
  const [keyTab, setKeyTab] = useState<AgentTab>("claude");
  const [readOnly, setReadOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [token, setToken] = useState("");
  const [tokenReadOnly, setTokenReadOnly] = useState(false);

  const commands = buildAgentCommands(window.location.origin);
  const keyCommands = buildApiKeyAgentCommands(window.location.origin, token);
  const keyCommand =
    keyTab === "claude" ? keyCommands.claudeCode : keyCommands.codex;

  const loadGrants = useCallback(async () => {
    setGrantsLoading(true);
    try {
      setGrants(await api.listOAuthGrants());
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, "Failed to load connected agents"));
    } finally {
      setGrantsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (disabled) {
      setGrants([]);
      return;
    }
    void loadGrants();
  }, [disabled, loadGrants]);

  const handleCopy = async (command: string) => {
    try {
      await copyTextToClipboard(command);
      setCopiedCommand(command);
      onSuccess("Command copied to clipboard");
      window.setTimeout(() => setCopiedCommand(""), 1500);
    } catch {
      setError("Failed to copy the command. Select and copy it manually.");
    }
  };

  const handleRevokeGrant = async (grant: api.OAuthGrant) => {
    setRevoking(true);
    setError("");
    onSuccess("");
    try {
      await api.revokeOAuthGrant(grant.id);
      setGrants((prev) => prev.filter((entry) => entry.id !== grant.id));
      onSuccess("Agent disconnected");
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, "Failed to disconnect the agent"));
    } finally {
      setRevoking(false);
      setGrantToRevoke(null);
    }
  };

  const handleCreateKey = async () => {
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
      setCopiedCommand("");
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

  const dismissToken = () => {
    setToken("");
    setTokenReadOnly(false);
    setCopiedCommand("");
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
                drawings or change sharing). Add the server to your agent, then
                sign in from the agent: your browser opens {APP_NAME} so you can
                approve access. No key to copy.
              </p>
            </div>

            <div className="px-4 py-3.5 sm:px-5">
              <AgentTabs
                idPrefix="agent"
                tab={tab}
                onChange={(next) => {
                  setTab(next);
                  setCopiedCommand("");
                }}
              />
              <div
                id="agent-panel"
                role="tabpanel"
                aria-labelledby={`agent-tab-${tab}`}
                className="mt-3 space-y-2"
              >
                {tab === "claude" ? (
                  <>
                    <p className={hintClass}>
                      1. Register the server for all your projects:
                    </p>
                    <CommandBlock
                      label="Claude Code command"
                      command={commands.claudeCode}
                      onCopy={(command) => void handleCopy(command)}
                      copied={copiedCommand === commands.claudeCode}
                    />
                    <p className={hintClass}>
                      2. In Claude Code, run <code>/mcp</code>, select{" "}
                      <code>{MCP_SERVER_NAME}</code> and choose{" "}
                      <strong>Authenticate</strong>. Approve access in the
                      browser window that opens.
                    </p>
                  </>
                ) : (
                  <>
                    <p className={hintClass}>
                      Add the server, then sign in (opens your browser to
                      approve access):
                    </p>
                    <CommandBlock
                      label="Codex command"
                      command={commands.codex}
                      onCopy={(command) => void handleCopy(command)}
                      copied={copiedCommand === commands.codex}
                    />
                  </>
                )}
              </div>
            </div>

            <div className="px-4 py-3.5 sm:px-5">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                Connected agents
              </h3>
              {grantsLoading && grants.length === 0 ? (
                <p className={`mt-1 ${hintClass}`}>Loading...</p>
              ) : grants.length === 0 ? (
                <p className={`mt-1 ${hintClass}`}>
                  No agent is signed in yet.
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {grants.map((grant) => {
                    const name = grant.clientName || "Unnamed agent";
                    return (
                      <li
                        key={grant.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-2"
                      >
                        <div className="min-w-0 flex-1 basis-40">
                          <p className="text-sm font-bold text-slate-900 dark:text-white break-words">
                            {name}
                          </p>
                          <p className={hintClass}>
                            {describeAgentAccess(grant.scopes)} · connected{" "}
                            {formatDate(grant.createdAt)} · last used{" "}
                            {formatDate(grant.lastUsedAt)}
                          </p>
                        </div>
                        <button
                          onClick={() => setGrantToRevoke(grant)}
                          disabled={revoking}
                          className="ui-button-secondary ml-auto text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/30"
                          aria-label={`Disconnect ${name}`}
                        >
                          <Trash2 size={14} />
                          Disconnect
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <details className="px-4 py-3.5 sm:px-5">
              <summary className="cursor-pointer text-sm font-bold text-slate-900 dark:text-white">
                Advanced: use an API key instead
              </summary>
              <div className="mt-3 space-y-3">
                <p className={hintClass}>
                  For scripts, or agents that cannot sign in with OAuth. Claude
                  Code prefers OAuth whenever the server offers it, so the
                  API-key header is mainly useful for Codex and scripts.
                </p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
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
                    onClick={() => void handleCreateKey()}
                    disabled={creating}
                    className="ui-button-primary ml-auto"
                  >
                    {creating ? "Creating..." : "Create key"}
                  </button>
                </div>

                {token && (
                  <div
                    className="border-l-4 border-amber-500 bg-slate-50 px-4 py-3.5 dark:bg-neutral-800"
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

                <AgentTabs
                  idPrefix="agent-key"
                  tab={keyTab}
                  onChange={(next) => {
                    setKeyTab(next);
                    setCopiedCommand("");
                  }}
                />
                <div
                  id="agent-key-panel"
                  role="tabpanel"
                  aria-labelledby={`agent-key-tab-${keyTab}`}
                  className="space-y-2"
                >
                  {keyTab === "codex" ? (
                    <p className={hintClass}>
                      Add the <code>export {AGENT_API_KEY_ENV_VAR}=…</code> line
                      to your shell profile (e.g. <code>~/.zshrc</code>) so
                      Codex finds the key in new terminals.
                    </p>
                  ) : (
                    <p className={hintClass}>
                      Registers the server for all your projects; check it with{" "}
                      <code>claude mcp list</code>.
                    </p>
                  )}
                  <CommandBlock
                    label={`${keyTab === "claude" ? "Claude Code" : "Codex"} API key command`}
                    command={keyCommand}
                    onCopy={(command) => void handleCopy(command)}
                    copied={copiedCommand === keyCommand}
                  />
                </div>
                <p className={hintClass}>
                  {token
                    ? "Keep this key secret. "
                    : "Replace <your-api-key> with a key, or create one above. "}
                  You can revoke agent keys at any time in the API keys list
                  above.
                </p>
              </div>
            </details>
          </SettingsCard>
        </>
      )}
      <ConfirmModal
        isOpen={Boolean(grantToRevoke)}
        title="Disconnect agent"
        message={
          grantToRevoke
            ? `Disconnect "${grantToRevoke.clientName || "Unnamed agent"}"? It loses access immediately and has to sign in again.`
            : ""
        }
        confirmText="Disconnect"
        onConfirm={() => grantToRevoke && void handleRevokeGrant(grantToRevoke)}
        onCancel={() => setGrantToRevoke(null)}
      />
    </section>
  );
};
