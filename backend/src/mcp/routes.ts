/**
 * Remote MCP endpoint (Streamable HTTP, stateless, JSON responses).
 *
 * Mounted at POST /mcp (public URL /api/mcp behind the bundled nginx). Only
 * Bearer API keys are accepted, so the route needs no CSRF protection, and no
 * OAuth metadata is advertised: MCP clients such as Claude Code skip their
 * static Authorization header when OAuth discovery succeeds.
 */
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { PrismaClient } from "../generated/client";
import { authenticateApiKey, isApiKeyToken } from "../auth/apiKeys";
import { config } from "../config";
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

const normalizeOrigin = (origin: string): string | null => {
  const withProtocol = /^https?:\/\//i.test(origin)
    ? origin
    : `http://${origin}`;
  try {
    return new URL(withProtocol).origin;
  } catch {
    return null;
  }
};

const firstHeaderValue = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim() || "";

/**
 * Origin used for browser links in tool output: the FRONTEND_URL entry that
 * matches the host the client called (several may be configured), else the
 * first entry, else the request's own origin.
 */
export const resolvePublicOrigin = (req: express.Request): string => {
  const configured = (config.frontendUrl ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizeOrigin)
    .filter((entry): entry is string => entry !== null);
  const host = firstHeaderValue(req.headers.host).toLowerCase();
  const proto =
    firstHeaderValue(req.headers["x-forwarded-proto"]).toLowerCase() ||
    req.protocol;
  if (configured.length > 0) {
    const sameHost = configured.filter(
      (origin) => new URL(origin).host.toLowerCase() === host,
    );
    return (
      sameHost.find((origin) => origin.startsWith(`${proto}:`)) ??
      sameHost[0] ??
      configured[0]
    );
  }
  return (
    normalizeOrigin(`${proto === "https" ? "https" : "http"}://${host}`) ??
    "http://localhost:6767"
  );
};

export const registerMcpRoutes = (
  app: express.Express,
  { prisma, getBackendVersion }: RegisterMcpRoutesDeps,
) => {
  app.post("/mcp", async (req, res) => {
    const token = readBearerToken(req);
    if (!token || !isApiKeyToken(token)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return jsonRpcError(
        res,
        401,
        -32001,
        "Unauthorized: send an API key as 'Authorization: Bearer <key>' (create one in Settings > API keys).",
      );
    }
    let auth;
    try {
      auth = await authenticateApiKey(prisma, token);
    } catch (error) {
      console.error("[mcp] API key verification failed:", error);
      return jsonRpcError(res, 500, -32603, "Failed to verify API key");
    }
    if (!auth) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return jsonRpcError(res, 401, -32001, "Invalid or revoked API key");
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
