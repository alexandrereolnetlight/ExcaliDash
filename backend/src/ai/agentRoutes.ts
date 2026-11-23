/**
 * POST /agent/chat — the in-editor assistant. Session + CSRF only (the global
 * CSRF middleware covers this path; API keys are refused), rate-limited per
 * user, streamed back as Server-Sent Events:
 *
 *   event: text   data: {"text": "..."}                       (deltas)
 *   event: tool   data: {"name", "summary", "isError"}
 *   event: done   data: {"usage", "stopReason", "outcome", "changedDrawing"}
 *   event: error  data: {"code", "message"}
 *   : ping        (comment every 15 s so idle streams survive the ALB)
 *
 * The tools act as the user through a short-lived API key minted for this
 * request (deleted when it ends), so every edit goes through the REST API with
 * the user's own permissions, validation, history snapshots and live broadcast.
 */
import express, { type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { PrismaClient } from "../generated/client";
import { config } from "../config";
import { logAuditEvent } from "../utils/audit";
import {
  createEphemeralApiKey,
  deleteExpiredEphemeralApiKeys,
} from "../auth/apiKeys";
import {
  createInternalApiClient,
  getInternalApiBaseUrl,
} from "../mcp/internalApi";
import { resolvePublicOrigin } from "../mcp/publicOrigin";
import { resolveUserAiCredential } from "./credentials";
import {
  createProxyClient,
  describeErrorForLog,
  describeProxyError,
} from "./proxy";
import { buildContextBlock } from "./prompt";
import { runAgent, type AgentEvent } from "./agent";

export const AGENT_RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 30 };
export const AGENT_LIMITS = {
  maxHistoryTurns: 40,
  maxTurnChars: 16_000,
  maxHistoryChars: 60_000,
  maxMessageChars: 8_000,
  maxSelectedIds: 500,
};
export const AGENT_KEY_TTL_MS = 15 * 60 * 1000;
export const AGENT_KEY_SCOPES = [
  "drawings:read",
  "drawings:write",
  "collections:read",
] as const;
const PING_INTERVAL_MS = 15_000;

const finite = z.number().finite();
const chatRequestSchema = z.object({
  drawingId: z.string().trim().min(1).max(200),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(AGENT_LIMITS.maxTurnChars),
      }),
    )
    .max(AGENT_LIMITS.maxHistoryTurns)
    .optional()
    .default([]),
  message: z.string().trim().min(1).max(AGENT_LIMITS.maxMessageChars),
  context: z
    .object({
      selectedElementIds: z
        .array(z.string().min(1).max(200))
        .max(AGENT_LIMITS.maxSelectedIds)
        .optional(),
      viewport: z
        .object({
          x: finite,
          y: finite,
          width: finite.positive(),
          height: finite.positive(),
          zoom: finite.positive(),
        })
        .optional(),
    })
    .optional()
    .default({}),
});

type RegisterAgentRoutesDeps = {
  prisma: PrismaClient;
  requireAuth: express.RequestHandler;
};

const jsonError = (
  res: Response,
  status: number,
  code: string,
  message: string,
) => res.status(status).json({ error: code, code, message });

export const registerAgentRoutes = (
  app: express.Express,
  { prisma, requireAuth }: RegisterAgentRoutesDeps,
) => {
  const ensureEnabled: express.RequestHandler = (_req, res, next) => {
    if (!config.ai.enabled) {
      return jsonError(res, 404, "not_found", "Not found");
    }
    next();
  };

  const requireSessionUser: express.RequestHandler = (req, res, next) => {
    if (!req.user) {
      return jsonError(res, 401, "unauthorized", "Authentication required");
    }
    if (req.user.authCredentialType === "apiKey") {
      return jsonError(
        res,
        403,
        "forbidden",
        "The assistant is only available from the web app",
      );
    }
    if (req.user.impersonatorId) {
      return jsonError(
        res,
        403,
        "forbidden",
        "The assistant is not available while impersonating",
      );
    }
    next();
  };

  const perUserLimiter = rateLimit({
    windowMs: AGENT_RATE_LIMIT.windowMs,
    max: AGENT_RATE_LIMIT.max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false, xForwardedForHeader: false },
    keyGenerator: (req) => `agent:${(req as Request).user?.id ?? "anonymous"}`,
    handler: (_req, res) =>
      jsonError(
        res,
        429,
        "rate_limited",
        "You have sent a lot of assistant requests. Wait a few minutes and try again.",
      ),
  });

  app.post(
    "/agent/chat",
    ensureEnabled,
    requireAuth,
    requireSessionUser,
    perUserLimiter,
    async (req: Request, res: Response) => {
      const user = req.user!;
      const parsed = chatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return jsonError(
          res,
          400,
          "invalid_request",
          "Invalid assistant request.",
        );
      }
      const { drawingId, messages, message, context } = parsed.data;
      const historyChars = messages.reduce(
        (sum, turn) => sum + turn.content.length,
        0,
      );
      if (historyChars > AGENT_LIMITS.maxHistoryChars) {
        return jsonError(
          res,
          413,
          "conversation_too_long",
          "This conversation is too long. Clear the chat and start a new one.",
        );
      }

      const ai = config.ai;
      if (!ai.proxyBaseUrl) {
        return jsonError(
          res,
          503,
          "not_configured",
          "The AI service URL (AI_PROXY_BASE_URL) is not configured.",
        );
      }
      const { credential } = await resolveUserAiCredential(prisma, user.id, ai);
      if (!credential.ok) {
        return jsonError(res, 409, "not_configured", credential.message);
      }

      void deleteExpiredEphemeralApiKeys(prisma).catch(() => undefined);
      let ephemeralKey: { id: string; token: string } | null = null;
      const controller = new AbortController();
      let finished = false;
      let ping: NodeJS.Timeout | null = null;
      const send = (event: string, data: unknown) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      res.on("close", () => {
        if (!finished) controller.abort();
      });

      try {
        ephemeralKey = await createEphemeralApiKey(prisma, {
          userId: user.id,
          name: "AI assistant session",
          scopes: AGENT_KEY_SCOPES,
          ttlMs: AGENT_KEY_TTL_MS,
        });
        const api = createInternalApiClient(
          ephemeralKey.token,
          getInternalApiBaseUrl(),
        );

        // Edit access to the drawing, checked through the REST API itself.
        const access = await api.request(
          "GET",
          `/drawings/${encodeURIComponent(drawingId)}?omitPreview=1`,
        );
        if (!access.ok) {
          return jsonError(
            res,
            access.status === 403 || access.status === 404 ? 404 : 502,
            "drawing_unavailable",
            access.status === 403 || access.status === 404
              ? "This drawing was not found, or you do not have access to it."
              : "Could not open this drawing. Try again.",
          );
        }
        const accessLevel = access.body?.accessLevel;
        if (accessLevel !== "edit" && accessLevel !== "owner") {
          return jsonError(
            res,
            403,
            "read_only",
            "You only have view access to this drawing, so the assistant cannot edit it.",
          );
        }

        if (config.enableAuditLogging) {
          await logAuditEvent({
            userId: user.id,
            action: "ai_assistant_request",
            resource: `drawing:${drawingId}`,
            ipAddress: req.ip || req.socket.remoteAddress || undefined,
            userAgent: req.headers["user-agent"] || undefined,
            details: { credential: credential.source },
          });
        }

        res.status(200);
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        res.write(": connected\n\n");
        ping = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
        }, PING_INTERVAL_MS);

        const emit = (event: AgentEvent) => {
          if (event.type === "text") send("text", { text: event.text });
          else
            send("tool", {
              name: event.name,
              summary: event.summary,
              isError: event.isError,
            });
        };

        try {
          const result = await runAgent({
            client: createProxyClient(ai.proxyBaseUrl, credential.key),
            model: ai.model,
            effort: ai.effort,
            serverFallbacks: ai.serverFallbacks,
            userId: user.id,
            history: messages,
            contextBlock: buildContextBlock({
              drawingId,
              selectedElementIds: context.selectedElementIds,
              viewport: context.viewport,
            }),
            message,
            toolContext: {
              api,
              scopes: AGENT_KEY_SCOPES,
              publicOrigin: resolvePublicOrigin(req),
            },
            emit,
            signal: controller.signal,
          });
          send("done", {
            usage: result.usage,
            stopReason: result.stopReason,
            outcome: result.outcome,
            iterations: result.iterations,
            changedDrawing: result.changedDrawing,
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          console.warn(`[agent] request failed: ${describeErrorForLog(error)}`);
          send(
            "error",
            describeProxyError(error, {
              model: ai.model,
              source: credential.source,
            }),
          );
        }
      } catch (error) {
        console.error(`[agent] setup failed: ${describeErrorForLog(error)}`);
        if (!res.headersSent) {
          return jsonError(
            res,
            500,
            "internal_error",
            "The assistant failed to start. Try again.",
          );
        }
        send("error", {
          code: "internal_error",
          message: "The assistant failed unexpectedly. Try again.",
        });
      } finally {
        finished = true;
        if (ping) clearInterval(ping);
        if (ephemeralKey) {
          await prisma.apiKey
            .deleteMany({ where: { id: ephemeralKey.id } })
            .catch(() => undefined);
        }
        if (res.headersSent && !res.writableEnded) res.end();
      }
    },
  );
};
