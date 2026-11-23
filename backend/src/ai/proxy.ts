/**
 * Talking to the LLM proxy (e.g. Netlight's LiteLLM): key validation and model
 * listing via GET {base}/v1/models, the Anthropic SDK client used for
 * /v1/messages, and friendly messages for proxy errors.
 *
 * Keys are only ever sent as `Authorization: Bearer <key>` to the configured
 * base URL (redirects are not followed) and are never logged.
 */
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { AiCredentialSource } from "./credentials";

const MODELS_TIMEOUT_MS = 8_000;
const MODELS_CACHE_TTL_MS = 2 * 60 * 1000;
const MODELS_CACHE_MAX_ENTRIES = 200;
const MESSAGES_TIMEOUT_MS = 5 * 60 * 1000;

export type ProxyModelsResult =
  | { status: "ok"; models: string[] }
  | { status: "rejected"; httpStatus: number }
  | { status: "error"; message: string };

const modelsCache = new Map<string, { models: string[]; expiresAt: number }>();

const cacheKeyFor = (baseUrl: string, key: string) =>
  crypto.createHash("sha256").update(`${baseUrl}\n${key}`).digest("hex");

export const clearProxyModelsCache = () => modelsCache.clear();

/**
 * GET {base}/v1/models with the key. 200 means the key is valid (and lists the
 * models it may use); 401/403 mean it was rejected.
 */
export const fetchProxyModels = async (
  baseUrl: string,
  key: string,
  { useCache = true }: { useCache?: boolean } = {},
): Promise<ProxyModelsResult> => {
  const cacheKey = cacheKeyFor(baseUrl, key);
  const cached = useCache ? modelsCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) {
    return { status: "ok", models: cached.models };
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/models`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
      redirect: "manual",
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
  } catch {
    return { status: "error", message: "Could not reach the AI service." };
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    return { status: "rejected", httpStatus: response.status };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return {
      status: "error",
      message: `The AI service could not check the key (HTTP ${response.status}).`,
    };
  }
  let models: string[] = [];
  try {
    const body: any = await response.json();
    const entries: unknown[] = Array.isArray(body?.data) ? body.data : [];
    models = Array.from(
      new Set(
        entries
          .map((entry: any) => (typeof entry?.id === "string" ? entry.id : ""))
          .filter((id) => id.length > 0 && id.length <= 200),
      ),
    )
      .sort()
      .slice(0, 500);
  } catch {
    models = [];
  }
  if (modelsCache.size >= MODELS_CACHE_MAX_ENTRIES) {
    const oldest = modelsCache.keys().next().value;
    if (oldest !== undefined) modelsCache.delete(oldest);
  }
  modelsCache.set(cacheKey, {
    models,
    expiresAt: Date.now() + MODELS_CACHE_TTL_MS,
  });
  return { status: "ok", models };
};

/**
 * Anthropic SDK client for the proxy. The key goes in `authToken`, which the
 * SDK sends as `Authorization: Bearer <key>` (no x-api-key); passing it also
 * stops the SDK from reading ANTHROPIC_* credentials from the environment.
 */
export const createProxyClient = (baseUrl: string, key: string) =>
  new Anthropic({
    baseURL: baseUrl,
    authToken: key,
    maxRetries: 1,
    timeout: MESSAGES_TIMEOUT_MS,
    // Never let ANTHROPIC_LOG=debug dump prompts, nor export prompt content
    // through OpenTelemetry spans.
    logLevel: "warn",
    openTelemetry: false,
  });

const redactKeys = (value: string) =>
  value.replace(/sk-[\x21-\x7e]+/g, "sk-…").replace(/\s+/g, " ");

const proxyMessage = (error: InstanceType<typeof Anthropic.APIError>) => {
  const body = error.error as any;
  const raw =
    typeof body?.error?.message === "string"
      ? body.error.message
      : typeof body?.message === "string"
        ? body.message
        : "";
  const cleaned = redactKeys(raw).trim();
  return cleaned ? cleaned.slice(0, 200) : "";
};

export type FriendlyProxyError = { code: string; message: string };

/** Map SDK / proxy errors to messages that are safe to show the user. */
export const describeProxyError = (
  error: unknown,
  { model, source }: { model: string; source: AiCredentialSource },
): FriendlyProxyError => {
  const keyOwner =
    source === "personal"
      ? "Your Netlight AI key"
      : "The shared AI key of this app";
  const fix =
    source === "personal"
      ? "Update or remove it in Settings."
      : "Ask an administrator to check AI_PROXY_API_KEY.";
  if (error instanceof Anthropic.AuthenticationError) {
    return {
      code: "key_rejected",
      message: `${keyOwner} was rejected by the AI service. ${fix}`,
    };
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return {
      code: "model_forbidden",
      message: `${keyOwner} has no access to the model "${model}".`,
    };
  }
  if (error instanceof Anthropic.NotFoundError) {
    return {
      code: "model_not_found",
      message: `The AI service does not offer the model "${model}".`,
    };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return {
      code: "rate_limited",
      message:
        "The AI service is rate limiting requests right now. Wait a moment and try again.",
    };
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return {
      code: "timeout",
      message: "The AI service did not respond in time. Try again.",
    };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return {
      code: "unreachable",
      message: "Could not reach the AI service. Try again in a moment.",
    };
  }
  if (error instanceof Anthropic.APIError && typeof error.status === "number") {
    if (error.status >= 500) {
      return {
        code: "upstream_error",
        message: `The AI service is having trouble (HTTP ${error.status}). Try again in a moment.`,
      };
    }
    const detail = proxyMessage(error);
    return {
      code: "request_rejected",
      message: `The AI service rejected the request (HTTP ${error.status})${detail ? `: ${detail}` : "."}`,
    };
  }
  return {
    code: "internal_error",
    message: "The assistant failed unexpectedly. Try again.",
  };
};

/** Log line without prompt content, keys or response bodies. */
export const describeErrorForLog = (error: unknown): string => {
  if (error instanceof Anthropic.APIError) {
    return `${error.constructor.name} status=${error.status ?? "n/a"} request_id=${error.requestID ?? "n/a"}`;
  }
  return error instanceof Error ? error.constructor.name : typeof error;
};
