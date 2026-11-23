/**
 * Which LLM proxy key a request uses: the user's personal key when one is
 * saved (and still decryptable), else the shared AI_PROXY_API_KEY, else none.
 * Keys never leave the server and are never logged.
 */
import type { PrismaClient } from "../generated/client";
import type { AiConfig } from "../config/ai";
import { decryptSecret } from "./crypto";

export type AiCredentialSource = "personal" | "shared";

export type ResolvedAiCredential =
  | {
      ok: true;
      source: AiCredentialSource;
      key: string;
      message: null;
      /** A personal key is saved but can no longer be decrypted. */
      personalKeyUnreadable: boolean;
    }
  | {
      ok: false;
      source: null;
      key: null;
      code: "not_configured";
      message: string;
      personalKeyUnreadable: boolean;
    };

export type StoredAiCredential = { keyEncrypted: string } | null;

/** LiteLLM-style virtual keys: "sk-" followed by printable ASCII. */
export const PROXY_KEY_PATTERN = /^sk-[\x21-\x7e]{4,500}$/;

export const keyHintOf = (key: string): string => key.slice(-4);

export const notConfiguredMessage = (personalKeysEnabled: boolean): string =>
  personalKeysEnabled
    ? "The AI assistant has no API key to use. An administrator can configure a shared key (AI_PROXY_API_KEY), or you can add your own Netlight AI key in Settings."
    : "The AI assistant has no API key to use. An administrator needs to configure a shared key (AI_PROXY_API_KEY).";

export const resolveAiCredential = ({
  userId,
  stored,
  sharedKey,
  encryptionKey,
}: {
  userId: string;
  stored: StoredAiCredential;
  sharedKey: string | null;
  encryptionKey: Buffer | null;
}): ResolvedAiCredential => {
  let personalKeyUnreadable = false;
  if (stored) {
    const personal = encryptionKey
      ? decryptSecret(stored.keyEncrypted, encryptionKey, userId)
      : null;
    if (personal) {
      return {
        ok: true,
        source: "personal",
        key: personal,
        message: null,
        personalKeyUnreadable,
      };
    }
    personalKeyUnreadable = true;
  }
  if (sharedKey) {
    return {
      ok: true,
      source: "shared",
      key: sharedKey,
      message: null,
      personalKeyUnreadable,
    };
  }
  return {
    ok: false,
    source: null,
    key: null,
    code: "not_configured",
    message: notConfiguredMessage(Boolean(encryptionKey)),
    personalKeyUnreadable,
  };
};

export const loadStoredAiCredential = (prisma: PrismaClient, userId: string) =>
  prisma.userAiCredential.findUnique({
    where: { userId },
    select: { keyEncrypted: true, keyHint: true, validatedAt: true },
  });

export const resolveUserAiCredential = async (
  prisma: PrismaClient,
  userId: string,
  ai: Pick<AiConfig, "proxyApiKey" | "keyEncryptionKey">,
) => {
  const stored = await loadStoredAiCredential(prisma, userId);
  return {
    stored,
    credential: resolveAiCredential({
      userId,
      stored,
      sharedKey: ai.proxyApiKey,
      encryptionKey: ai.keyEncryptionKey,
    }),
  };
};
