import crypto from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import request from "supertest";
import jwt from "jsonwebtoken";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PrismaClient } from "../generated/client";
import { config } from "../config";
import { generateApiKey, serializeApiKeyScopes } from "../auth/apiKeys";
import { getTestPrisma, setupTestDb } from "./testUtils";

// Must be set before the config module loads (imports are hoisted).
const previousFrontendUrl = vi.hoisted(() => {
  const previous = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL =
    "https://first.example.test,https://second.example.test";
  return previous;
});

const ORIGIN = "https://first.example.test";
const RESOURCE = `${ORIGIN}/api/mcp`;
const REDIRECT_URI = "http://127.0.0.1:33418/callback";
const ALL_SCOPES = [
  "drawings:read",
  "drawings:write",
  "collections:read",
  "collections:write",
];

type ToolResult = {
  content: { type: string; text: string }[];
  isError?: boolean;
};
type Tokens = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
};

const resultText = (result: unknown) =>
  (result as ToolResult).content.map((entry) => entry.text).join("\n");

const createPkce = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
};

describe("OAuth authorization server for the MCP endpoint", () => {
  let prisma: PrismaClient;
  let app: any;
  let httpServer: Server;
  let baseUrl: string;
  let userId: string;
  let sessionToken: string;
  let agent: any;
  let csrfHeaderName: string;
  let csrfToken: string;
  const userAgent = "vitest-oauth";
  const mcpClients: Client[] = [];

  // --- helpers ------------------------------------------------------------

  const register = async (body: Record<string, unknown>) => {
    const response = await fetch(`${baseUrl}/api/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const registerClient = async (redirectUris = [REDIRECT_URI]) => {
    const response = await register({
      client_name: "Claude Code (excalight)",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body as { client_id: string };
  };

  const authorize = async (params: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, value);
    }
    const response = await fetch(`${baseUrl}/api/oauth/authorize?${query}`, {
      redirect: "manual",
    });
    return response;
  };

  /** Runs /authorize and returns the opaque consent request id. */
  const startAuthorization = async (
    clientId: string,
    challenge: string,
    extra: Record<string, string | undefined> = {},
  ) => {
    const response = await authorize({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-123",
      resource: RESOURCE,
      ...extra,
    });
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location).toMatch(/^\/oauth\/consent\?request=[A-Za-z0-9_-]+$/);
    return new URL(location, ORIGIN).searchParams.get("request")!;
  };

  const sessionGet = (path: string) =>
    agent
      .get(path)
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${sessionToken}`);

  const sessionPost = (path: string, body: unknown, token = sessionToken) =>
    agent
      .post(path)
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${token}`)
      .set(csrfHeaderName, csrfToken)
      .send(body);

  const approve = (requestId: string, readOnly = false) =>
    sessionPost("/auth/oauth/authorization-request/approve", {
      request: requestId,
      readOnly,
    });

  const token = async (body: Record<string, string>) => {
    const response = await fetch(`${baseUrl}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    return { status: response.status, body: await response.json() };
  };

  const exchangeCode = (
    clientId: string,
    code: string,
    verifier: string,
    redirectUri = REDIRECT_URI,
  ) =>
    token({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: RESOURCE,
    });

  const refresh = (clientId: string, refreshToken: string) =>
    token({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    });

  /** register -> authorize -> consent -> token, like Claude Code does. */
  const connectAgent = async (
    options: { readOnly?: boolean; scope?: string } = {},
  ) => {
    const client = await registerClient();
    const { verifier, challenge } = createPkce();
    const requestId = await startAuthorization(client.client_id, challenge, {
      scope: options.scope,
    });
    const approved = await approve(requestId, options.readOnly);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const redirect = new URL(approved.body.redirectUrl);
    const code = redirect.searchParams.get("code")!;
    const exchanged = await exchangeCode(client.client_id, code, verifier);
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    return {
      clientId: client.client_id,
      code,
      verifier,
      tokens: exchanged.body as Tokens,
    };
  };

  const postMcp = (accessToken?: string) =>
    fetch(`${baseUrl}/api/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "oauth-test", version: "1" },
        },
      }),
    });

  const connectMcp = async (accessToken: string) => {
    const client = new Client({ name: "oauth-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      }),
    );
    mcpClients.push(client);
    return client;
  };

  const grantIdOf = async (accessToken: string) => {
    const keyId = accessToken.slice(4, 20);
    const row = await prisma.apiKey.findUniqueOrThrow({ where: { keyId } });
    return row.oauthGrantId!;
  };

  // --- setup --------------------------------------------------------------

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app, httpServer } = await import("../index"));
    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", () => resolve()),
    );
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true, registrationEnabled: false },
      create: { id: "default", authEnabled: true, registrationEnabled: false },
    });
    const user = await prisma.user.create({
      data: {
        email: "oauth-user@test.local",
        passwordHash: "x",
        name: "OAuth User",
      },
    });
    userId = user.id;
    sessionToken = jwt.sign(
      { userId, email: "oauth-user@test.local", type: "access" },
      config.jwtSecret,
      { expiresIn: "15m" },
    );
    agent = request.agent(app);
    const csrf = await agent.get("/csrf-token").set("User-Agent", userAgent);
    csrfHeaderName = csrf.body.header;
    csrfToken = csrf.body.token;
  });

  afterAll(async () => {
    await Promise.all(mcpClients.map((client) => client.close()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await prisma.$disconnect();
    if (previousFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previousFrontendUrl;
  });

  // --- metadata -----------------------------------------------------------

  describe("metadata", () => {
    it("serves protected resource metadata built from FRONTEND_URL", async () => {
      for (const path of [
        "/.well-known/oauth-protected-resource/api/mcp",
        "/.well-known/oauth-protected-resource",
      ]) {
        const response = await request(app).get(path);
        expect(response.status, path).toBe(200);
        expect(response.body).toMatchObject({
          resource: RESOURCE,
          authorization_servers: [ORIGIN],
          scopes_supported: ALL_SCOPES,
        });
      }
      // The FRONTEND_URL entry matching the Host wins; unknown hosts never
      // leak into the issuer.
      const second = await request(app)
        .get("/.well-known/oauth-protected-resource/api/mcp")
        .set("Host", "second.example.test");
      expect(second.body.resource).toBe("https://second.example.test/api/mcp");
      const evil = await request(app)
        .get("/.well-known/oauth-protected-resource/api/mcp")
        .set("Host", "evil.example");
      expect(evil.body.resource).toBe(RESOURCE);
      expect(evil.body.authorization_servers).toEqual([ORIGIN]);
    });

    it("serves authorization server metadata", async () => {
      const response = await request(app).get(
        "/.well-known/oauth-authorization-server",
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/api/oauth/authorize`,
        token_endpoint: `${ORIGIN}/api/oauth/token`,
        registration_endpoint: `${ORIGIN}/api/oauth/register`,
        revocation_endpoint: `${ORIGIN}/api/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ALL_SCOPES,
      });
      expect(response.headers["access-control-allow-origin"]).toBe("*");
    });

    it("points unauthenticated /mcp calls at the resource metadata", async () => {
      const response = await postMcp();
      expect(response.status).toBe(401);
      const challenge = response.headers.get("www-authenticate") ?? "";
      expect(challenge).toContain(
        `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`,
      );
      expect(challenge).not.toContain("invalid_token");
      const invalid = await postMcp("exd_aaaaaaaaaaaaaaaa_bbbbbbbb");
      expect(invalid.status).toBe(401);
      expect(invalid.headers.get("www-authenticate")).toContain(
        'error="invalid_token"',
      );
    });
  });

  // --- registration -------------------------------------------------------

  describe("dynamic client registration", () => {
    it("registers public clients with loopback redirect URIs", async () => {
      const response = await register({
        client_name: "  Claude <b>Code</b>\u0000 ",
        redirect_uris: [
          "http://localhost:4567/callback",
          "http://127.0.0.1/callback",
          "http://[::1]:9000/cb",
        ],
        token_endpoint_auth_method: "client_secret_post",
      });
      expect(response.status).toBe(201);
      expect(response.body.client_id).toEqual(expect.any(String));
      expect(response.body.client_secret).toBeUndefined();
      expect(response.body.token_endpoint_auth_method).toBe("none");
      expect(response.body.client_name).toBe("Claude bCode/b");
      expect(response.body.redirect_uris).toHaveLength(3);
    });

    it("rejects non-loopback redirect URIs", async () => {
      for (const redirectUris of [
        ["https://example.com/callback"],
        ["http://example.com/callback"],
        ["https://localhost:3000/callback"],
        ["http://localhost.evil.example/callback"],
        ["http://127.0.0.1@evil.example/callback"],
        ["http://user:pass@localhost/callback"],
        ["http://localhost:3000/callback", "https://evil.example/callback"],
        [],
      ]) {
        const response = await register({
          client_name: "Evil",
          redirect_uris: redirectUris,
        });
        expect(response.status, JSON.stringify(redirectUris)).toBe(400);
        expect(response.body.error, JSON.stringify(redirectUris)).toBe(
          "invalid_redirect_uri",
        );
      }
      const customScheme = await register({
        redirect_uris: ["com.example.app:/callback"],
      });
      expect(customScheme.status).toBe(400);
      expect(["invalid_redirect_uri", "invalid_client_metadata"]).toContain(
        customScheme.body.error,
      );
    });
  });

  // --- authorization endpoint ---------------------------------------------

  describe("authorization endpoint", () => {
    it("validates the request before showing the consent page", async () => {
      const client = await registerClient();
      const { challenge } = createPkce();
      const base = {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "xyz",
      };
      const errorOf = (response: Response) => {
        expect(response.status).toBe(302);
        const location = new URL(response.headers.get("location")!);
        expect(location.origin + location.pathname).toBe(REDIRECT_URI);
        expect(location.searchParams.get("state")).toBe("xyz");
        return location.searchParams.get("error");
      };

      expect(
        errorOf(await authorize({ ...base, code_challenge_method: "plain" })),
      ).toBe("invalid_request");
      expect(
        errorOf(await authorize({ ...base, code_challenge: undefined })),
      ).toBe("invalid_request");
      expect(
        errorOf(await authorize({ ...base, response_type: "token" })),
      ).toBe("unsupported_response_type");
      expect(
        errorOf(
          await authorize({ ...base, resource: "https://other.example/mcp" }),
        ),
      ).toBe("invalid_target");
      expect(errorOf(await authorize({ ...base, scope: "admin openid" }))).toBe(
        "invalid_scope",
      );

      // Never redirect to an unregistered URI: answer directly instead.
      for (const redirect of [
        "https://evil.example/callback",
        "http://127.0.0.1:33418/other",
        undefined,
      ]) {
        const response = await authorize({ ...base, redirect_uri: redirect });
        expect(response.status, String(redirect)).toBe(400);
        expect(response.headers.get("location")).toBeNull();
      }
      const unknownClient = await authorize({ ...base, client_id: "nope" });
      expect(unknownClient.status).toBe(400);
      expect((await unknownClient.json()).error).toBe("invalid_client");
    });

    it("always asks for consent and describes the request", async () => {
      const { clientId } = await connectAgent();
      // A client that was already approved still gets the consent page.
      const { challenge } = createPkce();
      const requestId = await startAuthorization(clientId, challenge, {
        scope: "drawings:read openid",
      });
      const details = await sessionGet(
        `/auth/oauth/authorization-request?request=${requestId}`,
      );
      expect(details.status).toBe(200);
      expect(details.body.request).toMatchObject({
        clientName: "Claude Code (excalight)",
        redirectHost: "127.0.0.1:33418",
        scopes: ["drawings:read"],
      });
      const unknown = await sessionGet(
        "/auth/oauth/authorization-request?request=does-not-exist",
      );
      expect(unknown.status).toBe(404);
    });

    it("only lets a signed-in browser session answer consent", async () => {
      const client = await registerClient();
      const { challenge } = createPkce();
      const requestId = await startAuthorization(client.client_id, challenge);

      const anonymous = await request(app).get(
        `/auth/oauth/authorization-request?request=${requestId}`,
      );
      expect(anonymous.status).toBe(401);

      const apiKey = generateApiKey();
      await prisma.apiKey.create({
        data: {
          userId,
          name: "personal",
          keyId: apiKey.keyId,
          tokenHash: apiKey.tokenHash,
          prefix: apiKey.prefix,
          scopes: serializeApiKeyScopes(),
        },
      });
      const withApiKey = await request(app)
        .post("/auth/oauth/authorization-request/approve")
        .set("Authorization", `Bearer ${apiKey.token}`)
        .send({ request: requestId });
      expect(withApiKey.status).toBe(403);

      const withoutCsrf = await agent
        .post("/auth/oauth/authorization-request/approve")
        .set("User-Agent", userAgent)
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ request: requestId });
      expect(withoutCsrf.status).toBe(403);

      // Still pending after the refused attempts.
      expect((await approve(requestId)).status).toBe(200);
      expect((await approve(requestId)).status).toBe(404);
    });

    it("refuses approval by an inactive user", async () => {
      const inactive = await prisma.user.create({
        data: {
          email: "oauth-inactive@test.local",
          passwordHash: "x",
          name: "Inactive",
          isActive: false,
        },
      });
      const inactiveSession = jwt.sign(
        { userId: inactive.id, email: inactive.email, type: "access" },
        config.jwtSecret,
        { expiresIn: "15m" },
      );
      const client = await registerClient();
      const { challenge } = createPkce();
      const requestId = await startAuthorization(client.client_id, challenge);
      const response = await sessionPost(
        "/auth/oauth/authorization-request/approve",
        { request: requestId },
        inactiveSession,
      );
      expect(response.status).toBe(401);
      expect(
        await prisma.oAuthAuthorizationCode.count({
          where: { userId: inactive.id },
        }),
      ).toBe(0);
    });

    it("redirects with access_denied when the user denies", async () => {
      const client = await registerClient();
      const { challenge } = createPkce();
      const requestId = await startAuthorization(client.client_id, challenge);
      const denied = await sessionPost(
        "/auth/oauth/authorization-request/deny",
        { request: requestId },
      );
      expect(denied.status).toBe(200);
      const redirect = new URL(denied.body.redirectUrl);
      expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
      expect(redirect.searchParams.get("error")).toBe("access_denied");
      expect(redirect.searchParams.get("state")).toBe("state-123");
      expect(redirect.searchParams.get("code")).toBeNull();
      expect((await approve(requestId)).status).toBe(404);
    });
  });

  // --- tokens -------------------------------------------------------------

  describe("token endpoint", () => {
    it("completes the flow and the access token works on /mcp", async () => {
      const { tokens } = await connectAgent();
      expect(tokens.token_type).toBe("Bearer");
      expect(tokens.expires_in).toBe(3600);
      expect(tokens.scope).toBe(ALL_SCOPES.join(" "));
      expect(tokens.access_token.startsWith("exd_")).toBe(true);
      expect(tokens.refresh_token.startsWith("exr_")).toBe(true);

      const client = await connectMcp(tokens.access_token);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("create_drawing");
      const created = (await client.callTool({
        name: "create_drawing",
        arguments: { name: "Via OAuth", elements: [{ type: "rectangle" }] },
      })) as ToolResult;
      expect(created.isError, resultText(created)).toBeFalsy();
      expect(resultText(created)).toContain(`url: ${ORIGIN}/editor/`);
      const drawing = await prisma.drawing.findFirst({
        where: { name: "Via OAuth" },
      });
      expect(drawing?.userId).toBe(userId);

      // Secrets are stored hashed only.
      const grantId = await grantIdOf(tokens.access_token);
      const refreshRows = await prisma.oAuthRefreshToken.findMany({
        where: { grantId },
      });
      expect(refreshRows).toHaveLength(1);
      expect(refreshRows[0].tokenHash).not.toContain(tokens.refresh_token);
    });

    it("issues read-only tokens when the user ticks read-only", async () => {
      const { tokens } = await connectAgent({ readOnly: true });
      expect(tokens.scope).toBe("drawings:read collections:read");
      const client = await connectMcp(tokens.access_token);
      const refused = (await client.callTool({
        name: "create_drawing",
        arguments: { name: "Nope", elements: [{ type: "rectangle" }] },
      })) as ToolResult;
      expect(refused.isError).toBe(true);
      expect(resultText(refused)).toContain("drawings:write");
      const listed = (await client.callTool({
        name: "list_drawings",
        arguments: {},
      })) as ToolResult;
      expect(listed.isError).toBeFalsy();
      const rest = await request(app)
        .post("/drawings")
        .set("Authorization", `Bearer ${tokens.access_token}`)
        .send({ name: "Denied", elements: [], appState: {} });
      expect(rest.status).toBe(403);
    });

    it("never grants more than requested", async () => {
      const { tokens } = await connectAgent({ scope: "drawings:read" });
      expect(tokens.scope).toBe("drawings:read");
    });

    it("rejects a wrong verifier, a wrong redirect_uri and a reused code", async () => {
      const client = await registerClient();
      const { verifier, challenge } = createPkce();
      const requestId = await startAuthorization(client.client_id, challenge);
      const approved = await approve(requestId);
      const code = new URL(approved.body.redirectUrl).searchParams.get("code")!;

      const wrongVerifier = await exchangeCode(
        client.client_id,
        code,
        createPkce().verifier,
      );
      expect(wrongVerifier.status).toBe(400);
      expect(wrongVerifier.body.error).toBe("invalid_grant");

      const wrongRedirect = await exchangeCode(
        client.client_id,
        code,
        verifier,
        "http://127.0.0.1:33418/other",
      );
      expect(wrongRedirect.status).toBe(400);
      expect(wrongRedirect.body.error).toBe("invalid_grant");

      const otherClient = await registerClient();
      const wrongClient = await exchangeCode(
        otherClient.client_id,
        code,
        verifier,
      );
      expect(wrongClient.body.error).toBe("invalid_grant");

      const wrongResource = await token({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        resource: "https://other.example/mcp",
      });
      expect(wrongResource.body.error).toBe("invalid_target");

      const ok = await exchangeCode(client.client_id, code, verifier);
      expect(ok.status).toBe(200);
      expect((await postMcp(ok.body.access_token)).status).toBe(200);

      // Replaying the code fails and revokes what it issued.
      const reused = await exchangeCode(client.client_id, code, verifier);
      expect(reused.status).toBe(400);
      expect(reused.body.error).toBe("invalid_grant");
      expect((await postMcp(ok.body.access_token)).status).toBe(401);
      expect(
        (await refresh(client.client_id, ok.body.refresh_token)).body.error,
      ).toBe("invalid_grant");
    });

    it("rotates refresh tokens and revokes the grant on reuse", async () => {
      const { clientId, tokens } = await connectAgent();
      const first = await refresh(clientId, tokens.refresh_token);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.refresh_token).not.toBe(tokens.refresh_token);
      expect(first.body.access_token).not.toBe(tokens.access_token);
      expect((await postMcp(first.body.access_token)).status).toBe(200);

      const second = await refresh(clientId, first.body.refresh_token);
      expect(second.status).toBe(200);
      expect((await postMcp(second.body.access_token)).status).toBe(200);

      // Narrowing on refresh is allowed, widening is not.
      const narrowed = await token({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: second.body.refresh_token,
        scope: "drawings:read admin",
      });
      expect(narrowed.body.error).toBe("invalid_scope");

      // Replaying an already rotated refresh token kills the whole grant.
      const replay = await refresh(clientId, tokens.refresh_token);
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe("invalid_grant");
      expect((await postMcp(second.body.access_token)).status).toBe(401);
      expect((await refresh(clientId, second.body.refresh_token)).status).toBe(
        400,
      );
      const grant = await prisma.oAuthGrant.findUniqueOrThrow({
        where: { id: await grantIdOf(tokens.access_token) },
      });
      expect(grant.revokedAt).toBeInstanceOf(Date);
    });

    it("rejects expired access tokens", async () => {
      const { tokens } = await connectAgent();
      expect((await postMcp(tokens.access_token)).status).toBe(200);
      await prisma.apiKey.update({
        where: { keyId: tokens.access_token.slice(4, 20) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const response = await postMcp(tokens.access_token);
      expect(response.status).toBe(401);
      const challenge = response.headers.get("www-authenticate") ?? "";
      expect(challenge).toContain('error="invalid_token"');
      expect(challenge).toContain("resource_metadata=");
      const rest = await request(app)
        .get("/drawings")
        .set("Authorization", `Bearer ${tokens.access_token}`);
      expect(rest.status).toBe(401);
    });

    it("revokes a grant through the revocation endpoint", async () => {
      const { clientId, tokens } = await connectAgent();
      const response = await fetch(`${baseUrl}/api/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          token: tokens.refresh_token,
          token_type_hint: "refresh_token",
        }).toString(),
      });
      expect(response.status).toBe(200);
      expect((await postMcp(tokens.access_token)).status).toBe(401);
      expect((await refresh(clientId, tokens.refresh_token)).status).toBe(400);
    });
  });

  // --- settings -----------------------------------------------------------

  describe("connected agents in settings", () => {
    it("lists grants instead of access-token keys and revokes them", async () => {
      await prisma.oAuthGrant.updateMany({
        where: { userId },
        data: { revokedAt: new Date() },
      });
      const { clientId, tokens } = await connectAgent({ readOnly: true });
      expect((await postMcp(tokens.access_token)).status).toBe(200);

      const grants = await sessionGet("/auth/oauth/grants");
      expect(grants.status).toBe(200);
      expect(grants.body.grants).toHaveLength(1);
      expect(grants.body.grants[0]).toMatchObject({
        clientName: "Claude Code (excalight)",
        scopes: ["drawings:read", "collections:read"],
      });
      expect(grants.body.grants[0].lastUsedAt).not.toBeNull();

      const apiKeys = await sessionGet("/auth/api-keys");
      expect(apiKeys.status).toBe(200);
      expect(
        apiKeys.body.apiKeys.some((key: { name: string }) =>
          key.name.includes("(OAuth)"),
        ),
      ).toBe(false);

      const revoked = await agent
        .delete(`/auth/oauth/grants/${grants.body.grants[0].id}`)
        .set("User-Agent", userAgent)
        .set("Authorization", `Bearer ${sessionToken}`)
        .set(csrfHeaderName, csrfToken);
      expect(revoked.status).toBe(200);
      expect((await postMcp(tokens.access_token)).status).toBe(401);
      expect((await refresh(clientId, tokens.refresh_token)).body.error).toBe(
        "invalid_grant",
      );
      expect((await sessionGet("/auth/oauth/grants")).body.grants).toEqual([]);
    });

    it("does not let another user revoke a grant", async () => {
      const { tokens } = await connectAgent();
      const grantId = await grantIdOf(tokens.access_token);
      const other = await prisma.user.create({
        data: { email: "oauth-other@test.local", passwordHash: "x", name: "O" },
      });
      const otherSession = jwt.sign(
        { userId: other.id, email: other.email, type: "access" },
        config.jwtSecret,
        { expiresIn: "15m" },
      );
      const response = await agent
        .delete(`/auth/oauth/grants/${grantId}`)
        .set("User-Agent", userAgent)
        .set("Authorization", `Bearer ${otherSession}`)
        .set(csrfHeaderName, csrfToken);
      expect(response.status).toBe(404);
      expect((await postMcp(tokens.access_token)).status).toBe(200);
    });
  });
});
