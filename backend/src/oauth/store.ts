/**
 * Persistence and token logic of the OAuth 2.1 authorization server that
 * protects the remote MCP endpoint.
 *
 * - Clients: dynamically registered, public (no secret), loopback redirects.
 * - Authorization requests: validated /authorize parameters awaiting consent.
 * - Authorization codes: single use, bound to client, redirect URI, PKCE
 *   challenge, user, granted scopes and resource.
 * - Grants: one per consent; own the refresh and access tokens.
 * - Refresh tokens: rotated on every use; replaying one revokes the grant.
 * - Access tokens: short-lived ApiKey rows (expiresAt + oauthGrantId), so
 *   the REST auth middleware and the MCP loopback client accept them as is.
 *
 * Every secret (request id, code, refresh token, access token) is stored
 * hashed only.
 */
import crypto from "crypto";
import {
  CustomOAuthError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Prisma, PrismaClient } from "../generated/client";
import {
  apiKeyHashMatches,
  extractApiKeyId,
  generateApiKey,
  isApiKeyToken,
  parseApiKeyScopes,
  serializeApiKeyScopes,
} from "../auth/apiKeys";
import { hashTokenForStorage } from "../auth/tokenSecurity";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  AUTHORIZATION_REQUEST_TTL_MS,
  OAUTH_READ_ONLY_SCOPES,
  OAUTH_SCOPES,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_TTL_MS,
  resourceMatches,
} from "./constants";

const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_STATE_LENGTH = 1024;
const MAX_CLIENT_ID_LENGTH = 100;
const UNUSED_CLIENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const randomSecret = () => crypto.randomBytes(32).toString("base64url");

const timingSafeStringEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

// ---------------------------------------------------------------------------
// Validation helpers

/** Only plain-http loopback redirects (RFC 8252 §7.3), so codes never leave the user's machine. */
export const isLoopbackRedirectUri = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > MAX_REDIRECT_URI_LENGTH)
    return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.hash
  );
};

/** Self-reported client names are display-only: strip control chars and markup. */
export const sanitizeClientName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CLIENT_NAME_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
};

/**
 * Scopes for an authorization request: unknown scopes are ignored (RFC 6749
 * §3.3 lets the server narrow the request); none requested means all.
 */
export const resolveRequestedScopes = (requested: string[] | undefined) => {
  const tokens = (requested ?? [])
    .flatMap((entry) => entry.split(" "))
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (tokens.length === 0) return [...OAUTH_SCOPES];
  const known = OAUTH_SCOPES.filter((scope) => tokens.includes(scope));
  if (known.length === 0) {
    throw new InvalidScopeError(
      `None of the requested scopes are supported (supported: ${OAUTH_SCOPES.join(" ")})`,
    );
  }
  return known;
};

const parseRedirectUris = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------

export type OAuthStore = ReturnType<typeof createOAuthStore>;

export const createOAuthStore = (prisma: PrismaClient) => {
  const toClientInfo = (client: {
    id: string;
    clientName: string | null;
    redirectUris: string;
    createdAt: Date;
  }): OAuthClientInformationFull => ({
    client_id: client.id,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    ...(client.clientName ? { client_name: client.clientName } : {}),
    redirect_uris: parseRedirectUris(client.redirectUris),
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });

  const getClient = async (clientId: string) => {
    if (
      typeof clientId !== "string" ||
      clientId.length === 0 ||
      clientId.length > MAX_CLIENT_ID_LENGTH
    ) {
      return undefined;
    }
    const client = await prisma.oAuthClient.findUnique({
      where: { id: clientId },
    });
    return client ? toClientInfo(client) : undefined;
  };

  /**
   * RFC 7591 registration. Every client is public: whatever auth method was
   * asked for, the response says "none" and carries no secret.
   */
  const registerClient = async (
    metadata: Omit<
      OAuthClientInformationFull,
      "client_id" | "client_id_issued_at"
    > & {
      client_id?: string;
    },
  ): Promise<OAuthClientInformationFull> => {
    const redirectUris = metadata.redirect_uris ?? [];
    if (
      redirectUris.length === 0 ||
      redirectUris.length > MAX_REDIRECT_URIS ||
      !redirectUris.every(isLoopbackRedirectUri)
    ) {
      throw new CustomOAuthError(
        "invalid_redirect_uri",
        "redirect_uris must be loopback http URIs (http://localhost, http://127.0.0.1 or http://[::1], any port)",
      );
    }
    const grantTypes = metadata.grant_types ?? ["authorization_code"];
    if (
      grantTypes.some(
        (grant) => grant !== "authorization_code" && grant !== "refresh_token",
      )
    ) {
      throw new InvalidClientMetadataError(
        "Only the authorization_code and refresh_token grant types are supported",
      );
    }
    if ((metadata.response_types ?? ["code"]).some((type) => type !== "code")) {
      throw new InvalidClientMetadataError(
        "Only the code response type is supported",
      );
    }
    void cleanupExpired();
    const client = await prisma.oAuthClient.create({
      data: {
        id: metadata.client_id || crypto.randomUUID(),
        clientName: sanitizeClientName(metadata.client_name),
        redirectUris: JSON.stringify(Array.from(new Set(redirectUris))),
      },
    });
    return toClientInfo(client);
  };

  // -------------------------------------------------------------------------
  // Authorization requests (pending consent)

  const createAuthorizationRequest = async (input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state?: string;
    scopes: string[];
    resource?: string;
  }): Promise<string> => {
    if (input.state && input.state.length > MAX_STATE_LENGTH) {
      throw new InvalidRequestError("state is too long");
    }
    const requestId = randomSecret();
    await prisma.oAuthAuthorizationRequest.create({
      data: {
        requestHash: hashTokenForStorage(requestId),
        clientId: input.clientId,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        state: input.state ?? null,
        scopes: serializeApiKeyScopes(input.scopes),
        resource: input.resource ?? null,
        expiresAt: new Date(Date.now() + AUTHORIZATION_REQUEST_TTL_MS),
      },
    });
    return requestId;
  };

  const findPendingRequest = async (requestId: unknown) => {
    if (typeof requestId !== "string" || requestId.length > 200) return null;
    const request = await prisma.oAuthAuthorizationRequest.findUnique({
      where: { requestHash: hashTokenForStorage(requestId) },
      include: { client: true },
    });
    if (!request || request.expiresAt.getTime() <= Date.now()) return null;
    return request;
  };

  const describeAuthorizationRequest = async (requestId: unknown) => {
    const request = await findPendingRequest(requestId);
    if (!request) return null;
    return {
      clientName: request.client.clientName,
      redirectUri: request.redirectUri,
      redirectHost: new URL(request.redirectUri).host,
      scopes: parseApiKeyScopes(request.scopes),
      expiresAt: request.expiresAt,
    };
  };

  /** Consumes the request so it can be answered only once. */
  const takePendingRequest = async (requestId: unknown) => {
    const request = await findPendingRequest(requestId);
    if (!request) return null;
    const { count } = await prisma.oAuthAuthorizationRequest.deleteMany({
      where: { id: request.id },
    });
    return count === 1 ? request : null;
  };

  const buildRedirect = (
    redirectUri: string,
    params: Record<string, string | null | undefined>,
  ) => {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    return url.href;
  };

  const approveAuthorizationRequest = async (
    requestId: unknown,
    userId: string,
    readOnly: boolean,
  ): Promise<
    { redirectUrl: string } | { error: "not_found" | "no_scopes" }
  > => {
    const pending = await findPendingRequest(requestId);
    if (!pending) return { error: "not_found" };
    const requested = parseApiKeyScopes(pending.scopes);
    // Never grant more than requested; read-only narrows further.
    const granted = readOnly
      ? requested.filter((scope) => OAUTH_READ_ONLY_SCOPES.includes(scope))
      : requested;
    if (granted.length === 0) return { error: "no_scopes" };
    const request = await takePendingRequest(requestId);
    if (!request) return { error: "not_found" };
    const code = randomSecret();
    await prisma.oAuthAuthorizationCode.create({
      data: {
        codeHash: hashTokenForStorage(code),
        clientId: request.clientId,
        userId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        scopes: serializeApiKeyScopes(granted),
        resource: request.resource,
        expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
      },
    });
    return {
      redirectUrl: buildRedirect(request.redirectUri, {
        code,
        state: request.state,
      }),
    };
  };

  const denyAuthorizationRequest = async (
    requestId: unknown,
  ): Promise<string | null> => {
    const request = await takePendingRequest(requestId);
    if (!request) return null;
    return buildRedirect(request.redirectUri, {
      error: "access_denied",
      error_description: "The user denied the request",
      state: request.state,
    });
  };

  // -------------------------------------------------------------------------
  // Grants and tokens

  const revokeGrant = async (grantId: string) => {
    const now = new Date();
    await prisma.$transaction([
      prisma.oAuthGrant.updateMany({
        where: { id: grantId, revokedAt: null },
        data: { revokedAt: now },
      }),
      prisma.oAuthRefreshToken.updateMany({
        where: { grantId, revokedAt: null },
        data: { revokedAt: now },
      }),
      prisma.apiKey.updateMany({
        where: { oauthGrantId: grantId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
  };

  const accessTokenName = (clientName: string | null) =>
    `${clientName || "MCP client"} (OAuth)`.slice(0, MAX_CLIENT_NAME_LENGTH);

  /** Hashing (scrypt) happens before the transaction opens. */
  const prepareTokens = () => ({
    access: generateApiKey(),
    refresh: `${REFRESH_TOKEN_PREFIX}${randomSecret()}`,
  });

  const storeTokens = async (
    tx: Prisma.TransactionClient,
    prepared: ReturnType<typeof prepareTokens>,
    grant: { id: string; userId: string },
    clientName: string | null,
    scopes: string[],
  ): Promise<OAuthTokens> => {
    const now = Date.now();
    await tx.apiKey.create({
      data: {
        userId: grant.userId,
        name: accessTokenName(clientName),
        keyId: prepared.access.keyId,
        tokenHash: prepared.access.tokenHash,
        prefix: prepared.access.prefix,
        scopes: serializeApiKeyScopes(scopes),
        expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
        oauthGrantId: grant.id,
      },
    });
    await tx.oAuthRefreshToken.create({
      data: {
        tokenHash: hashTokenForStorage(prepared.refresh),
        grantId: grant.id,
        expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
      },
    });
    return {
      access_token: prepared.access.token,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: prepared.refresh,
      scope: scopes.join(" "),
    };
  };

  const verifyPkce = (verifier: string, challenge: string) => {
    // RFC 7636: 43-128 chars from the unreserved set.
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
    const computed = crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");
    return timingSafeStringEqual(computed, challenge);
  };

  const exchangeAuthorizationCode = async (input: {
    client: OAuthClientInformationFull;
    code: string;
    codeVerifier: string | undefined;
    redirectUri: string | undefined;
    resource: string | undefined;
  }): Promise<OAuthTokens> => {
    const record = await prisma.oAuthAuthorizationCode.findUnique({
      where: { codeHash: hashTokenForStorage(input.code) },
      include: { client: true, user: true },
    });
    if (!record || record.clientId !== input.client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    if (record.usedAt) {
      // RFC 6749 §4.1.2: a replayed code revokes what it already issued.
      if (record.grantId) await revokeGrant(record.grantId);
      throw new InvalidGrantError("Authorization code was already used");
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new InvalidGrantError("Authorization code expired");
    }
    if (!input.redirectUri || input.redirectUri !== record.redirectUri) {
      throw new InvalidGrantError(
        "redirect_uri does not match the authorization request",
      );
    }
    if (
      input.resource &&
      record.resource &&
      !resourceMatches(input.resource, record.resource)
    ) {
      throw new InvalidTargetError(
        "resource does not match the authorization request",
      );
    }
    if (
      !input.codeVerifier ||
      !verifyPkce(input.codeVerifier, record.codeChallenge)
    ) {
      throw new InvalidGrantError("code_verifier does not match the challenge");
    }
    if (!record.user.isActive) {
      throw new InvalidGrantError("User account is inactive");
    }
    const scopes = parseApiKeyScopes(record.scopes);
    const prepared = prepareTokens();
    return prisma.$transaction(async (tx) => {
      const consumed = await tx.oAuthAuthorizationCode.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) {
        throw new InvalidGrantError("Authorization code was already used");
      }
      const grant = await tx.oAuthGrant.create({
        data: {
          userId: record.userId,
          clientId: record.clientId,
          scopes: serializeApiKeyScopes(scopes),
          resource: record.resource,
          lastUsedAt: new Date(),
        },
      });
      await tx.oAuthAuthorizationCode.update({
        where: { id: record.id },
        data: { grantId: grant.id },
      });
      return storeTokens(tx, prepared, grant, record.client.clientName, scopes);
    });
  };

  const exchangeRefreshToken = async (input: {
    client: OAuthClientInformationFull;
    refreshToken: string;
    scopes: string[] | undefined;
    resource: string | undefined;
  }): Promise<OAuthTokens> => {
    const record = await prisma.oAuthRefreshToken.findUnique({
      where: { tokenHash: hashTokenForStorage(input.refreshToken) },
      include: { grant: { include: { client: true, user: true } } },
    });
    if (!record || record.grant.clientId !== input.client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    const { grant } = record;
    if (grant.revokedAt) throw new InvalidGrantError("Grant was revoked");
    if (record.usedAt || record.revokedAt) {
      // A rotated token came back: assume it leaked and kill the grant.
      await revokeGrant(grant.id);
      throw new InvalidGrantError("Refresh token was already used");
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new InvalidGrantError("Refresh token expired");
    }
    if (
      input.resource &&
      grant.resource &&
      !resourceMatches(input.resource, grant.resource)
    ) {
      throw new InvalidTargetError("resource does not match the grant");
    }
    const grantScopes = parseApiKeyScopes(grant.scopes);
    let scopes = grantScopes;
    if (input.scopes && input.scopes.filter(Boolean).length > 0) {
      const requested = input.scopes.filter(Boolean);
      if (requested.some((scope) => !grantScopes.includes(scope))) {
        throw new InvalidScopeError("Requested scope exceeds the grant");
      }
      scopes = grantScopes.filter((scope) => requested.includes(scope));
    }
    if (!grant.user.isActive) {
      throw new InvalidGrantError("User account is inactive");
    }
    const prepared = prepareTokens();
    const result = await prisma.$transaction(async (tx) => {
      const consumed = await tx.oAuthRefreshToken.updateMany({
        where: { id: record.id, usedAt: null, revokedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) return null;
      await tx.oAuthGrant.update({
        where: { id: grant.id },
        data: { lastUsedAt: new Date() },
      });
      return storeTokens(tx, prepared, grant, grant.client.clientName, scopes);
    });
    if (!result) {
      await revokeGrant(grant.id);
      throw new InvalidGrantError("Refresh token was already used");
    }
    void cleanupExpired();
    return result;
  };

  /** RFC 7009: unknown tokens and tokens of other clients are ignored. */
  const revokeToken = async (
    client: OAuthClientInformationFull,
    token: string,
  ) => {
    if (isApiKeyToken(token)) {
      const keyId = extractApiKeyId(token);
      if (!keyId) return;
      const apiKey = await prisma.apiKey.findUnique({
        where: { keyId },
        include: { oauthGrant: { select: { clientId: true } } },
      });
      if (
        !apiKey?.oauthGrant ||
        apiKey.oauthGrant.clientId !== client.client_id ||
        !apiKeyHashMatches(token, apiKey.tokenHash)
      ) {
        return;
      }
      await prisma.apiKey.updateMany({
        where: { id: apiKey.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return;
    }
    const record = await prisma.oAuthRefreshToken.findUnique({
      where: { tokenHash: hashTokenForStorage(token) },
      include: { grant: { select: { clientId: true } } },
    });
    if (!record || record.grant.clientId !== client.client_id) return;
    await revokeGrant(record.grantId);
  };

  // -------------------------------------------------------------------------
  // Settings UI

  /** Grants that can still be used: not revoked, with a live refresh token. */
  const listActiveGrants = async (userId: string) => {
    const now = new Date();
    const grants = await prisma.oAuthGrant.findMany({
      where: {
        userId,
        revokedAt: null,
        refreshTokens: {
          some: { expiresAt: { gt: now }, usedAt: null, revokedAt: null },
        },
      },
      include: { client: { select: { clientName: true } } },
      orderBy: { createdAt: "desc" },
    });
    return grants.map((grant) => ({
      id: grant.id,
      clientName: grant.client.clientName,
      scopes: parseApiKeyScopes(grant.scopes),
      createdAt: grant.createdAt,
      lastUsedAt: grant.lastUsedAt,
    }));
  };

  const revokeUserGrant = async (userId: string, grantId: string) => {
    const grant = await prisma.oAuthGrant.findFirst({
      where: { id: grantId, userId },
      select: { id: true },
    });
    if (!grant) return false;
    await revokeGrant(grant.id);
    return true;
  };

  // -------------------------------------------------------------------------
  // Housekeeping

  let lastCleanupAt = 0;
  /**
   * Deletes expired requests, codes, refresh tokens and access-token rows,
   * and clients that never completed an authorization. Throttled; called
   * opportunistically on registration and token issuance.
   */
  const cleanupExpired = async (force = false) => {
    const nowMs = Date.now();
    if (!force && nowMs - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    lastCleanupAt = nowMs;
    const now = new Date(nowMs);
    try {
      await prisma.oAuthAuthorizationRequest.deleteMany({
        where: { expiresAt: { lt: now } },
      });
      await prisma.oAuthAuthorizationCode.deleteMany({
        where: { expiresAt: { lt: now } },
      });
      await prisma.oAuthRefreshToken.deleteMany({
        where: { expiresAt: { lt: now } },
      });
      await prisma.apiKey.deleteMany({
        where: { oauthGrantId: { not: null }, expiresAt: { lt: now } },
      });
      await prisma.oAuthClient.deleteMany({
        where: {
          createdAt: { lt: new Date(nowMs - UNUSED_CLIENT_TTL_MS) },
          grants: { none: {} },
          authorizationCodes: { none: {} },
          authorizationRequests: { none: {} },
        },
      });
    } catch (error) {
      console.warn("[oauth] cleanup failed:", error);
    }
  };

  return {
    getClient,
    registerClient,
    createAuthorizationRequest,
    describeAuthorizationRequest,
    approveAuthorizationRequest,
    denyAuthorizationRequest,
    exchangeAuthorizationCode,
    exchangeRefreshToken,
    revokeToken,
    revokeGrant,
    listActiveGrants,
    revokeUserGrant,
    cleanupExpired,
  };
};
