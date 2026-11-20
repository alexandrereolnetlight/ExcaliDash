/**
 * Session-only endpoints behind the OAuth consent page and the "Connected
 * agents" list in Settings. API keys and OAuth access tokens are refused:
 * only a signed-in browser session (cookie + CSRF) may approve or revoke.
 */
import { Request, Response } from "express";
import { z } from "zod";
import { logAuditEvent } from "../utils/audit";
import { createOAuthStore } from "../oauth/store";
import type { RegisterAccountRoutesDeps } from "./accountRoutes";

const requestIdSchema = z.string().min(1).max(200);
const approveSchema = z.object({
  request: requestIdSchema,
  readOnly: z.boolean().optional(),
});
const denySchema = z.object({ request: requestIdSchema });

export const registerAccountOAuthRoutes = (deps: RegisterAccountRoutesDeps) => {
  const {
    router,
    prisma,
    requireAuth,
    accountActionRateLimiter,
    ensureAuthEnabled,
    config,
    requireCsrf,
  } = deps;
  const store = createOAuthStore(prisma);

  const requireSessionUser = (
    req: Request,
    res: Response,
  ): req is Request & { user: NonNullable<Request["user"]> } => {
    if (!req.user) {
      res
        .status(401)
        .json({ error: "Unauthorized", message: "User not authenticated" });
      return false;
    }
    if (req.user.authCredentialType !== "jwt") {
      res.status(403).json({
        error: "Forbidden",
        message: "Sign in to the app in your browser to manage AI agent access",
      });
      return false;
    }
    return true;
  };

  const audit = async (req: Request, action: string, resource: string) => {
    if (!config.enableAuditLogging || !req.user) return;
    await logAuditEvent({
      userId: req.user.id,
      action,
      resource,
      ipAddress: req.ip || req.connection.remoteAddress || undefined,
      userAgent: req.headers["user-agent"] || undefined,
    });
  };

  const notFound = (res: Response) =>
    res.status(404).json({
      error: "Not found",
      message:
        "This authorization request has expired or was already answered. Start the sign-in again from your AI agent.",
    });

  router.get(
    "/oauth/authorization-request",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        if (!(await ensureAuthEnabled(res))) return;
        if (!requireSessionUser(req, res)) return;
        res.setHeader("Cache-Control", "no-store");
        const parsed = requestIdSchema.safeParse(req.query.request);
        const details = parsed.success
          ? await store.describeAuthorizationRequest(parsed.data)
          : null;
        if (!details) return notFound(res);
        return res.json({
          request: {
            clientName: details.clientName,
            redirectHost: details.redirectHost,
            scopes: details.scopes,
            expiresAt: details.expiresAt,
          },
        });
      } catch (error) {
        console.error("Read OAuth authorization request error:", error);
        return res.status(500).json({
          error: "Internal server error",
          message: "Failed to load the authorization request",
        });
      }
    },
  );

  router.post(
    "/oauth/authorization-request/approve",
    requireAuth,
    accountActionRateLimiter,
    async (req: Request, res: Response) => {
      try {
        if (!(await ensureAuthEnabled(res))) return;
        if (!requireCsrf(req, res)) return;
        if (!requireSessionUser(req, res)) return;
        if (req.user.impersonatorId) {
          return res.status(403).json({
            error: "Forbidden",
            message:
              "Connecting an AI agent is not allowed while impersonating",
          });
        }
        const parsed = approveSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Validation error", message: "Invalid request" });
        }
        const user = await prisma.user.findUnique({
          where: { id: req.user.id },
          select: { isActive: true },
        });
        if (!user?.isActive) {
          return res.status(403).json({
            error: "Forbidden",
            message: "User account is inactive",
          });
        }
        const result = await store.approveAuthorizationRequest(
          parsed.data.request,
          req.user.id,
          parsed.data.readOnly === true,
        );
        if ("error" in result) {
          if (result.error === "no_scopes") {
            return res.status(400).json({
              error: "Validation error",
              message: "The agent did not request read access.",
            });
          }
          return notFound(res);
        }
        await audit(req, "oauth_authorization_approved", "oauth");
        res.setHeader("Cache-Control", "no-store");
        return res.json({ redirectUrl: result.redirectUrl });
      } catch (error) {
        console.error("Approve OAuth authorization request error:", error);
        return res.status(500).json({
          error: "Internal server error",
          message: "Failed to approve the authorization request",
        });
      }
    },
  );

  router.post(
    "/oauth/authorization-request/deny",
    requireAuth,
    accountActionRateLimiter,
    async (req: Request, res: Response) => {
      try {
        if (!(await ensureAuthEnabled(res))) return;
        if (!requireCsrf(req, res)) return;
        if (!requireSessionUser(req, res)) return;
        const parsed = denySchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Validation error", message: "Invalid request" });
        }
        const redirectUrl = await store.denyAuthorizationRequest(
          parsed.data.request,
        );
        if (!redirectUrl) return notFound(res);
        res.setHeader("Cache-Control", "no-store");
        return res.json({ redirectUrl });
      } catch (error) {
        console.error("Deny OAuth authorization request error:", error);
        return res.status(500).json({
          error: "Internal server error",
          message: "Failed to deny the authorization request",
        });
      }
    },
  );

  router.get(
    "/oauth/grants",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        if (!(await ensureAuthEnabled(res))) return;
        if (!requireSessionUser(req, res)) return;
        return res.json({ grants: await store.listActiveGrants(req.user.id) });
      } catch (error) {
        console.error("List OAuth grants error:", error);
        return res.status(500).json({
          error: "Internal server error",
          message: "Failed to list connected agents",
        });
      }
    },
  );

  router.delete(
    "/oauth/grants/:id",
    requireAuth,
    accountActionRateLimiter,
    async (req: Request, res: Response) => {
      try {
        if (!(await ensureAuthEnabled(res))) return;
        if (!requireCsrf(req, res)) return;
        if (!requireSessionUser(req, res)) return;
        if (req.user.impersonatorId) {
          return res.status(403).json({
            error: "Forbidden",
            message: "Revoking agent access is not allowed while impersonating",
          });
        }
        const id = String(req.params.id);
        if (!(await store.revokeUserGrant(req.user.id, id))) {
          return res
            .status(404)
            .json({ error: "Not found", message: "Connected agent not found" });
        }
        await audit(req, "oauth_grant_revoked", `oauth_grant:${id}`);
        return res.json({ success: true });
      } catch (error) {
        console.error("Revoke OAuth grant error:", error);
        return res.status(500).json({
          error: "Internal server error",
          message: "Failed to revoke agent access",
        });
      }
    },
  );
};
