import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import * as api from "../api";
import { APP_NAME } from "../branding";
import { Logo } from "../components/Logo";
import { useAuth } from "../context/AuthContext";
import {
  AGENT_READ_ONLY_SCOPES,
  isLoopbackRedirectUrl,
  OAUTH_SCOPE_LABELS,
} from "../utils/agentConnect";

const getApiErrorMessage = (err: unknown, fallback: string) => {
  if (api.isAxiosError(err)) {
    if (err.response?.data?.message) return err.response.data.message;
    if (err.response?.data?.error) return err.response.data.error;
  }
  return fallback;
};

type Props = {
  /** Sends the browser back to the agent; replaceable in tests. */
  onRedirect?: (url: string) => void;
};

const defaultRedirect = (url: string) => window.location.assign(url);

/**
 * OAuth consent screen for MCP clients (Claude Code, Codex...). Reached from
 * /api/oauth/authorize with an opaque request id; ProtectedRoute signs the
 * user in first and returns here. Approving never happens automatically.
 */
export const OAuthConsent: React.FC<Props> = ({
  onRedirect = defaultRedirect,
}) => {
  const [searchParams] = useSearchParams();
  const requestId = searchParams.get("request") ?? "";
  const { user } = useAuth();
  const [details, setDetails] =
    useState<api.OAuthAuthorizationRequestDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
  const [finished, setFinished] = useState<"approve" | "deny" | null>(null);

  useEffect(() => {
    if (!requestId) {
      setError(
        "This page needs an authorization request. Start the sign-in from your AI agent.",
      );
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getOAuthAuthorizationRequest(requestId)
      .then((result) => {
        if (!cancelled) setDetails(result);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(
            getApiErrorMessage(err, "Failed to load the authorization request"),
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  const respond = async (action: "approve" | "deny") => {
    if (submitting || finished) return;
    setSubmitting(action);
    setError("");
    try {
      const { redirectUrl } =
        action === "approve"
          ? await api.approveOAuthAuthorizationRequest(requestId, readOnly)
          : await api.denyOAuthAuthorizationRequest(requestId);
      if (!isLoopbackRedirectUrl(redirectUrl)) {
        throw new Error("Refusing to redirect outside this computer");
      }
      setFinished(action);
      onRedirect(redirectUrl);
    } catch (err: unknown) {
      const fallback = "Failed to answer the authorization request";
      setError(
        api.isAxiosError(err)
          ? getApiErrorMessage(err, fallback)
          : err instanceof Error
            ? err.message
            : fallback,
      );
    } finally {
      setSubmitting(null);
    }
  };

  const clientName = details?.clientName || "An unnamed application";
  const requestedScopes = details?.scopes ?? [];
  const canBeReadOnly =
    requestedScopes.some((scope) => AGENT_READ_ONLY_SCOPES.includes(scope)) &&
    requestedScopes.some((scope) => !AGENT_READ_ONLY_SCOPES.includes(scope));
  const shownScopes = readOnly
    ? requestedScopes.filter((scope) => AGENT_READ_ONLY_SCOPES.includes(scope))
    : requestedScopes;

  return (
    <div className="auth-page">
      <div className="auth-wrap">
        <div className="text-center">
          <Logo className="mx-auto h-12 w-auto" />
          <h2 className="auth-heading">
            {details
              ? `${clientName} wants to access your drawings`
              : `Connect an AI agent to ${APP_NAME}`}
          </h2>
        </div>
        <div className="auth-panel">
          {error && (
            <div className="ui-alert-error" role="alert">
              <div>{error}</div>
            </div>
          )}
          {loading ? (
            <p className="text-sm text-slate-600 dark:text-neutral-400">
              Loading...
            </p>
          ) : finished ? (
            <p
              className="text-sm font-medium text-slate-700 dark:text-neutral-300"
              aria-live="polite"
            >
              {finished === "approve"
                ? "Access granted. Returning to your agent; you can close this tab."
                : "Access denied. Returning to your agent; you can close this tab."}
            </p>
          ) : details ? (
            <div className="space-y-4">
              <p className="text-xs font-medium text-slate-500 dark:text-neutral-400">
                The name "{clientName}" is reported by the application itself
                and is not verified. Only continue if you just started signing
                in from your AI agent (for example <code>/mcp</code> in Claude
                Code or <code>codex mcp login</code>).
              </p>
              <div>
                <p className="text-sm font-bold text-slate-900 dark:text-white">
                  It will be able to:
                </p>
                <ul className="mt-1 list-disc pl-5 text-sm text-slate-700 dark:text-neutral-300">
                  {shownScopes.map((scope) => (
                    <li key={scope}>{OAUTH_SCOPE_LABELS[scope] ?? scope}</li>
                  ))}
                </ul>
                <p className="mt-1 text-xs font-medium text-slate-500 dark:text-neutral-400">
                  It cannot change sharing settings or your account.
                </p>
              </div>
              {canBeReadOnly && (
                <label className="flex items-center gap-2 rounded-lg border-2 border-slate-200 bg-slate-50 px-2.5 py-1.5 text-sm font-medium text-slate-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                  <input
                    type="checkbox"
                    checked={readOnly}
                    onChange={(event) => setReadOnly(event.target.checked)}
                    className="h-3.5 w-3.5 accent-emerald-600"
                  />
                  <span>Read-only (the agent can view but not edit)</span>
                </label>
              )}
              <p className="flex items-start gap-2 text-xs font-medium text-slate-500 dark:text-neutral-400">
                <ShieldCheck size={14} className="mt-0.5 shrink-0" />
                <span>
                  {user ? `Signed in as ${user.email}. ` : ""}
                  Your browser then returns to the agent at{" "}
                  <code>{details.redirectHost}</code> on this computer. You can
                  disconnect the agent at any time in Settings.
                </span>
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => void respond("deny")}
                  disabled={submitting !== null}
                  className="ui-button-secondary flex-1"
                >
                  {submitting === "deny" ? "Denying..." : "Deny"}
                </button>
                <button
                  type="button"
                  onClick={() => void respond("approve")}
                  disabled={submitting !== null}
                  className="ui-button-primary flex-1"
                >
                  {submitting === "approve" ? "Allowing..." : "Allow"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
