/**
 * /auth/ai/* — assistant status and the optional personal proxy key
 * ("use my own Netlight AI key"). Session (+ CSRF for writes) only: API keys
 * are rejected by the auth middleware for these routes, and explicitly here.
 * The key itself is never returned, logged or audited; only its last four
 * characters are kept in clear.
 */
import type { Request, Response } from "express";
import { config } from "../config";
import { logAuditEvent } from "../utils/audit";
import type { RegisterAccountRoutesDeps } from "../auth/accountRoutes";
import { encryptSecret } from "./crypto";
import {
  keyHintOf,
  PROXY_KEY_PATTERN,
  resolveUserAiCredential,
} from "./credentials";
import { fetchProxyModels } from "./proxy";

const notFound = (res: Response) =>
  res.status(404).json({
    error: "Not found",
    message: "The AI assistant is not enabled",
  });

/** Status for the current user; `models` lists what the effective key may use. */
export const buildAiStatus = async (
  prisma: RegisterAccountRoutesDeps["prisma"],
  userId: string,
) => {
  const ai = config.ai;
  if (!ai.enabled) return { enabled: false as const };
  const { stored, credential } = await resolveUserAiCredential(
    prisma,
    userId,
    ai,
  );
  let models: string[] | null = null;
  let modelsError: string | null = null;
  if (!ai.proxyBaseUrl) {
    modelsError = "The AI service URL (AI_PROXY_BASE_URL) is not configured.";
  } else if (credential.ok) {
    const result = await fetchProxyModels(ai.proxyBaseUrl, credential.key);
    if (result.status === "ok") {
      models = result.models;
    } else if (result.status === "rejected") {
      modelsError =
        credential.source === "personal"
          ? "The AI service rejected your key. Update or remove it."
          : "The AI service rejected the shared key. Ask an administrator to check AI_PROXY_API_KEY.";
    } else {
      modelsError = result.message;
    }
  }
  return {
    enabled: true as const,
    model: ai.model,
    effort: ai.effort,
    personalKeysEnabled: Boolean(ai.keyEncryptionKey),
    sharedKeyAvailable: Boolean(ai.proxyApiKey),
    credentialAvailable: credential.ok && Boolean(ai.proxyBaseUrl),
    credentialSource: credential.ok ? credential.source : null,
    usingPersonalKey: credential.ok && credential.source === "personal",
    personalKey: stored
      ? { hint: stored.keyHint, validatedAt: stored.validatedAt }
      : null,
    personalKeyUnreadable: credential.personalKeyUnreadable,
    message: credential.message,
    models,
    modelAvailable: models ? models.includes(ai.model) : null,
    modelsError,
  };
};

export const registerAiAccountRoutes = (deps: RegisterAccountRoutesDeps) => {
  const { router, prisma, requireAuth, accountActionRateLimiter, requireCsrf } =
    deps;

  // Belt and braces: the auth middleware already refuses API keys here.
  const sessionUser = (req: Request, res: Response) => {
    if (!req.user) {
      res
        .status(401)
        .json({ error: "Unauthorized", message: "User not authenticated" });
      return null;
    }
    if (req.user.authCredentialType === "apiKey") {
      res.status(403).json({
        error: "Forbidden",
        message: "Sign in to the web app to use the AI assistant",
      });
      return null;
    }
    return req.user;
  };

  const audit = async (req: Request, userId: string, action: string) => {
    if (!config.enableAuditLogging) return;
    await logAuditEvent({
      userId,
      action,
      ipAddress: req.ip || req.socket.remoteAddress || undefined,
      userAgent: req.headers["user-agent"] || undefined,
    });
  };

  router.get("/ai/status", requireAuth, async (req, res) => {
    try {
      const user = sessionUser(req, res);
      if (!user) return;
      res.setHeader("Cache-Control", "no-store");
      return res.json(await buildAiStatus(prisma, user.id));
    } catch (error) {
      console.error(
        "AI status error:",
        error instanceof Error ? error.message : error,
      );
      return res.status(500).json({
        error: "Internal server error",
        message: "Failed to load the AI assistant status",
      });
    }
  });

  router.put(
    "/ai/key",
    requireAuth,
    accountActionRateLimiter,
    async (req, res) => {
      try {
        if (!config.ai.enabled) return notFound(res);
        if (!requireCsrf(req, res)) return;
        const user = sessionUser(req, res);
        if (!user) return;
        if (user.impersonatorId) {
          return res.status(403).json({
            error: "Forbidden",
            message: "AI keys cannot be changed while impersonating",
          });
        }
        const encryptionKey = config.ai.keyEncryptionKey;
        if (!encryptionKey) {
          return res.status(409).json({
            error: "Personal keys disabled",
            message:
              "Personal AI keys are not enabled on this server (AI_KEY_ENCRYPTION_KEY is not set).",
          });
        }
        const baseUrl = config.ai.proxyBaseUrl;
        if (!baseUrl) {
          return res.status(503).json({
            error: "Not configured",
            message:
              "The AI service URL (AI_PROXY_BASE_URL) is not configured.",
          });
        }
        const raw = (req.body ?? {}).key;
        const key = typeof raw === "string" ? raw.trim() : "";
        if (!PROXY_KEY_PATTERN.test(key)) {
          return res.status(400).json({
            error: "Validation error",
            message:
              'Enter a Netlight AI key: it starts with "sk-" and has no spaces.',
          });
        }
        const validation = await fetchProxyModels(baseUrl, key, {
          useCache: false,
        });
        if (validation.status === "rejected") {
          return res.status(400).json({
            error: "Key rejected",
            message:
              "The AI service rejected this key. Check that you copied all of it.",
          });
        }
        if (validation.status === "error") {
          return res.status(502).json({
            error: "Validation failed",
            message: `${validation.message} The key was not saved.`,
          });
        }
        const data = {
          keyEncrypted: encryptSecret(key, encryptionKey, user.id),
          keyHint: keyHintOf(key),
          validatedAt: new Date(),
        };
        await prisma.userAiCredential.upsert({
          where: { userId: user.id },
          create: { userId: user.id, ...data },
          update: data,
        });
        await audit(req, user.id, "ai_key_saved");
        return res.json(await buildAiStatus(prisma, user.id));
      } catch (error) {
        console.error(
          "Save AI key error:",
          error instanceof Error ? error.message : error,
        );
        return res.status(500).json({
          error: "Internal server error",
          message: "Failed to save the AI key",
        });
      }
    },
  );

  router.delete(
    "/ai/key",
    requireAuth,
    accountActionRateLimiter,
    async (req, res) => {
      try {
        if (!config.ai.enabled) return notFound(res);
        if (!requireCsrf(req, res)) return;
        const user = sessionUser(req, res);
        if (!user) return;
        if (user.impersonatorId) {
          return res.status(403).json({
            error: "Forbidden",
            message: "AI keys cannot be changed while impersonating",
          });
        }
        await prisma.userAiCredential.deleteMany({
          where: { userId: user.id },
        });
        await audit(req, user.id, "ai_key_removed");
        return res.json(await buildAiStatus(prisma, user.id));
      } catch (error) {
        console.error(
          "Remove AI key error:",
          error instanceof Error ? error.message : error,
        );
        return res.status(500).json({
          error: "Internal server error",
          message: "Failed to remove the AI key",
        });
      }
    },
  );
};
