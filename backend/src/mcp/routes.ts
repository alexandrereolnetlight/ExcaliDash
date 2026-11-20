/**
 * Remote MCP endpoint (Streamable HTTP, stateless, JSON responses).
 *
 * Mounted at POST /mcp (public URL /api/mcp behind the bundled nginx). Only
 * Bearer tokens are accepted (so the route needs no CSRF protection): OAuth
 * access tokens issued by this server's own authorization server (see
 * ../oauth) and personal API keys. Both are ApiKey rows, so the loopback REST
 * calls made by the tools accept them too. A 401 points OAuth clients at the
 * protected resource metadata (RFC 9728).
 */
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { PrismaClient } from "../generated/client";
import { authenticateApiKey, isApiKeyToken } from "../auth/apiKeys";
import { getOAuthPublicUrls, OAUTH_SCOPES } from "../oauth/constants";
import { resolvePublicOrigin } from "./publicOrigin";
import { createInternalApiClient, getInternalApiBaseUrl } from "./internalApi";
import { createMcpServer } from "./tools";

type RegisterMcpRoutesDeps = {
  prisma: PrismaClient;
  getBackendVersion: () => string;
};

const jsonRpcError = (
  res: express.Response,
  status: number,
  code: number,
  message: string,
) =>
  res
    .status(status)
    .json({ jsonrpc: "2.0", error: { code, message }, id: null });

const readBearerToken = (req: express.Request): string | null => {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (rest.length > 0 || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }
  return token;
};

export { resolvePublicOrigin };

/**
 * RFC 6750 / RFC 9728 challenge: points OAuth clients at the protected
 * resource metadata, from which they discover the authorization server.
 */
const sendUnauthorized = (
  req: express.Request,
  res: express.Response,
  message: string,
  tokenPresented: boolean,
) => {
  const params = [
    ...(tokenPresented
      ? ['error="invalid_token"', `error_description="${message}"`]
      : []),
    `resource_metadata="${getOAuthPublicUrls(req).resourceMetadata}"`,
    `scope="${OAUTH_SCOPES.join(" ")}"`,
  ];
  res.setHeader("WWW-Authenticate", `Bearer ${params.join(", ")}`);
  return jsonRpcError(res, 401, -32001, message);
};

export const registerMcpRoutes = (
  app: express.Express,
  { prisma, getBackendVersion }: RegisterMcpRoutesDeps,
) => {
  app.post("/mcp", async (req, res) => {
    const token = readBearerToken(req);
    if (!token) {
      return sendUnauthorized(
        req,
        res,
        "Unauthorized: sign in with OAuth, or send an API key as 'Authorization: Bearer <key>'",
        false,
      );
    }
    if (!isApiKeyToken(token)) {
      return sendUnauthorized(req, res, "Invalid access token", true);
    }
    let auth;
    try {
      auth = await authenticateApiKey(prisma, token);
    } catch (error) {
      console.error("[mcp] API key verification failed:", error);
      return jsonRpcError(res, 500, -32603, "Failed to verify API key");
    }
    if (!auth) {
      return sendUnauthorized(
        req,
        res,
        "Invalid, expired or revoked access token",
        true,
      );
    }
    if (auth.drawingId) {
      return jsonRpcError(
        res,
        403,
        -32001,
        "Drawing-scoped API keys are not supported; create an account API key.",
      );
    }

    const server = createMcpServer({
      api: createInternalApiClient(token, getInternalApiBaseUrl()),
      scopes: auth.scopes,
      publicOrigin: resolvePublicOrigin(req),
      serverVersion: getBackendVersion(),
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[mcp] request failed:", error);
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  const methodNotAllowed: express.RequestHandler = (_req, res) => {
    res.setHeader("Allow", "POST");
    jsonRpcError(
      res,
      405,
      -32000,
      "Method not allowed: this MCP server is stateless and only accepts POST.",
    );
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
};
