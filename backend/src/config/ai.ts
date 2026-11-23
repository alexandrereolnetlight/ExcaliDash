import { readBoolean, readOptionalString, readString } from "./env";
import { AI_EFFORT_VALUES } from "./registry/ai";

export type AiEffort = (typeof AI_EFFORT_VALUES)[number];

export interface AiConfig {
  /** Master switch for the in-editor assistant and its /auth/ai + /agent routes. */
  enabled: boolean;
  /** Proxy base URL without a trailing slash, or null when unset. */
  proxyBaseUrl: string | null;
  /** Shared proxy key used when a user has no personal key. */
  proxyApiKey: string | null;
  model: string;
  effort: AiEffort;
  /** AES-256-GCM key for personal proxy keys; null disables personal keys. */
  keyEncryptionKey: Buffer | null;
  /** Send `fallbacks: "default"` with the server-side-fallback beta. */
  serverFallbacks: boolean;
}

/**
 * Parse a 32-byte key given as 64 hex characters or as (url-safe) base64.
 * Returns null for anything else.
 */
export const parseKeyEncryptionKey = (raw: string): Buffer | null => {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(
    value.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  );
  return decoded.length === 32 ? decoded : null;
};

const resolveEffort = (): AiEffort => {
  const raw = readString("AI_EFFORT", "medium").trim().toLowerCase();
  const match = AI_EFFORT_VALUES.find((value) => value === raw);
  if (!match) {
    throw new Error(
      `Invalid AI_EFFORT. Expected one of: ${AI_EFFORT_VALUES.join(", ")}`,
    );
  }
  return match;
};

export const resolveAiConfig = (): AiConfig => {
  const rawEncryptionKey = readOptionalString("AI_KEY_ENCRYPTION_KEY");
  let keyEncryptionKey: Buffer | null = null;
  if (rawEncryptionKey) {
    keyEncryptionKey = parseKeyEncryptionKey(rawEncryptionKey);
    if (!keyEncryptionKey) {
      throw new Error(
        "Invalid AI_KEY_ENCRYPTION_KEY: expected 32 bytes as 64 hex characters or base64 (e.g. `openssl rand -base64 32`)",
      );
    }
  }
  const proxyBaseUrl =
    readOptionalString("AI_PROXY_BASE_URL")?.replace(/\/+$/, "") || null;
  if (proxyBaseUrl && !/^https?:\/\//i.test(proxyBaseUrl)) {
    throw new Error("Invalid AI_PROXY_BASE_URL: must start with http(s)://");
  }
  return {
    enabled: readBoolean("AI_ASSISTANT_ENABLED", false),
    proxyBaseUrl,
    proxyApiKey: readOptionalString("AI_PROXY_API_KEY"),
    model: readOptionalString("AI_MODEL") || "claude-opus-5-5",
    effort: resolveEffort(),
    keyEncryptionKey,
    serverFallbacks: readBoolean("AI_SERVER_FALLBACKS", false),
  };
};
