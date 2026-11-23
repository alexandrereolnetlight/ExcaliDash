import React, { useEffect, useState } from "react";
import { ExternalLink, Sparkles, Trash2 } from "lucide-react";
import {
  getAiStatus,
  removeAiKey,
  saveAiKey,
  type EnabledAiStatus,
} from "../../api/ai";
import { APP_NAME } from "../../branding";
import { getApiErrorMessage } from "../../utils/getApiErrorMessage";
import {
  SettingsCard,
  SettingsSectionHeader,
  settingsButtonClass,
  settingsPrimaryButtonClass,
  settingsSelectClass,
} from "./SettingsRow";

const NETLIGHT_PORTAL_URL = "https://portal.netlight.ai/";

type Props = {
  disabled?: boolean;
  onSuccess: (message: string) => void;
};

/** "AI assistant" settings; renders nothing while the assistant is off. */
export const AiAssistantCard: React.FC<Props> = ({
  disabled = false,
  onSuccess,
}) => {
  const [status, setStatus] = useState<EnabledAiStatus | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getAiStatus()
      .then((next) => {
        if (!cancelled) setStatus(next.enabled ? next : null);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return null;

  const apply = async (
    action: () => Promise<Awaited<ReturnType<typeof getAiStatus>>>,
    success: string,
    fallback: string,
  ) => {
    setBusy(true);
    setError("");
    try {
      const next = await action();
      if (next.enabled) setStatus(next);
      setKeyInput("");
      onSuccess(success);
    } catch (err) {
      setError(getApiErrorMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    const key = keyInput.trim();
    if (!key) return;
    void apply(
      () => saveAiKey(key),
      "Your Netlight AI key was saved.",
      "Could not save the key.",
    );
  };

  const remove = () =>
    void apply(
      () => removeAiKey(),
      "Your Netlight AI key was removed.",
      "Could not remove the key.",
    );

  const statusText = status.usingPersonalKey
    ? `Using your key …${status.personalKey?.hint ?? ""}`
    : status.credentialSource === "shared"
      ? `Using ${APP_NAME}'s shared key`
      : "No key available";

  return (
    <section>
      <SettingsSectionHeader
        icon={<Sparkles size={20} />}
        tileClassName="border-black bg-sky-300 text-black dark:border-neutral-700 dark:bg-sky-300 dark:text-black"
        title="AI assistant"
        subtitle={`Chat with an assistant that can edit your ${APP_NAME} drawings`}
      />
      <SettingsCard>
        <div className="px-4 py-3.5 sm:px-5">
          <p
            className="text-sm font-bold text-slate-900 dark:text-white"
            data-testid="ai-status"
          >
            {statusText}
          </p>
          <p className="mt-0.5 text-xs font-medium text-slate-500 dark:text-neutral-400">
            Model: {status.model}
          </p>
          {status.modelAvailable === false ? (
            <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
              This key cannot use {status.model}.
            </p>
          ) : null}
          {status.modelsError ? (
            <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
              {status.modelsError}
            </p>
          ) : null}
          {status.personalKeyUnreadable ? (
            <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
              Your saved key can no longer be read by the server. Remove it and
              add it again.
            </p>
          ) : null}
          {!status.credentialAvailable && status.message ? (
            <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
              {status.message}
            </p>
          ) : null}
        </div>
        {status.personalKeysEnabled ? (
          <form className="px-4 py-3.5 sm:px-5" onSubmit={save}>
            <label
              htmlFor="ai-personal-key"
              className="text-sm font-bold text-slate-900 dark:text-white"
            >
              Use my own Netlight AI key
            </label>
            <p className="mt-0.5 text-xs font-medium text-slate-500 dark:text-neutral-400">
              Optional. Requests then run on your key instead of {APP_NAME}'s.
              The key is stored encrypted and never shown again.{" "}
              <a
                href={NETLIGHT_PORTAL_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 font-semibold text-indigo-600 underline dark:text-indigo-400"
              >
                Get a key at portal.netlight.ai
                <ExternalLink size={12} />
              </a>
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                id="ai-personal-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  status.personalKey
                    ? `Replace key …${status.personalKey.hint}`
                    : "sk-…"
                }
                value={keyInput}
                onChange={(event) => setKeyInput(event.target.value)}
                disabled={disabled || busy}
                className={`${settingsSelectClass} min-w-0 flex-1 basis-56`}
              />
              <button
                type="submit"
                className={settingsPrimaryButtonClass}
                disabled={disabled || busy || !keyInput.trim()}
              >
                Save
              </button>
              {status.personalKey ? (
                <button
                  type="button"
                  onClick={remove}
                  disabled={disabled || busy}
                  className={`${settingsButtonClass} text-rose-600 dark:text-rose-400`}
                >
                  <Trash2 size={14} />
                  Remove
                </button>
              ) : null}
            </div>
            {error ? (
              <p
                role="alert"
                className="mt-2 text-xs font-medium text-rose-600 dark:text-rose-400"
              >
                {error}
              </p>
            ) : null}
          </form>
        ) : null}
      </SettingsCard>
    </section>
  );
};
