/**
 * Public OAuth 2.1 endpoints of the authorization server protecting /mcp.
 *
 * Backend path                                  Public URL (bundled nginx)
 * /.well-known/oauth-protected-resource[/api/mcp]  same (forwarded unstripped)
 * /.well-known/oauth-authorization-server          same (forwarded unstripped)
 * /oauth/{authorize,token,register,revoke}         /api/oauth/...
 *
 * These take no cookies and need no CSRF protection, so they are registered
 * ahead of it. The consent screen is an SPA page backed by session-only JSON
 * endpoints in ../auth/accountOAuthRoutes.ts.
 */
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import {
  InvalidClientError,
  InvalidRequestError,
  InvalidTargetError,
  OAuthError,
  ServerError,
  TooManyRequestsError,
  UnsupportedResponseTypeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { PrismaClient } from "../generated/client";
import {
  CONSENT_PAGE_PATH,
  getOAuthPublicUrls,
  OAUTH_SCOPES,
  resourceMatches,
} from "./constants";
import { createOAuthStore, resolveRequestedScopes } from "./store";

// express-rate-limit's proxy checks are handled app-wide (see index.ts).
const rateLimitValidation = {
  validate: { trustProxy: false, xForwardedForHeader: false },
} as const;

export const registerOAuthRoutes = (
  app: express.Express,
  { prisma }: { prisma: PrismaClient },
) => {
  const store = createOAuthStore(prisma);

  const clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId) => store.getClient(clientId),
    registerClient: (client) => store.registerClient(client),
  };

  const provider: OAuthServerProvider = {
    get clientsStore() {
      return clientsStore;
    },
    // PKCE is verified in the store (constant time, S256 only) while the
    // code is consumed.
    skipLocalPkceValidation: true,

    // Served by our own /oauth/authorize handler below.
    async authorize() {
      throw new Error("Handled by the /oauth/authorize route");
    },

    async challengeForAuthorizationCode() {
      throw new Error("PKCE is verified by exchangeAuthorizationCode");
    },

    exchangeAuthorizationCode: (
      client,
      code,
      codeVerifier,
      redirectUri,
      resource,
    ) =>
      store.exchangeAuthorizationCode({
        client,
        code,
        codeVerifier,
        redirectUri,
        resource: resource?.href,
      }),

    exchangeRefreshToken: (client, refreshToken, scopes, resource) =>
      store.exchangeRefreshToken({
        client,
        refreshToken,
        scopes,
        resource: resource?.href,
      }),

    async verifyAccessToken() {
      throw new Error("Access tokens are verified by authenticateApiKey");
    },

    revokeToken: (client, request) => store.revokeToken(client, request.token),
  };

  const oauthError = (res: express.Response, error: OAuthError) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(400).json(error.toResponseObject());
  };

  // --- Metadata (RFC 9728 and RFC 8414) ------------------------------------
  const metadataCors = cors();
  const protectedResourcePaths = [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/api/mcp",
  ];
  app.options(protectedResourcePaths, metadataCors);
  app.get(protectedResourcePaths, metadataCors, (req, res) => {
    const urls = getOAuthPublicUrls(req);
    res.json({
      resource: urls.resource,
      authorization_servers: [urls.issuer],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
    });
  });

  const authorizationServerPath = "/.well-known/oauth-authorization-server";
  app.options(authorizationServerPath, metadataCors);
  app.get(authorizationServerPath, metadataCors, (req, res) => {
    const urls = getOAuthPublicUrls(req);
    res.json({
      issuer: urls.issuer,
      authorization_endpoint: urls.authorizationEndpoint,
      token_endpoint: urls.tokenEndpoint,
      registration_endpoint: urls.registrationEndpoint,
      revocation_endpoint: urls.revocationEndpoint,
      scopes_supported: OAUTH_SCOPES,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
    });
  });

  // --- Authorization endpoint ----------------------------------------------
  // Own handler (instead of the SDK's) so `state` is echoed on every error
  // redirect, and redirect_uri is mandatory so the token request is bound
  // to it. Errors before client and redirect_uri are validated are answered
  // directly: nothing is ever redirected to an unregistered URI.
  const authorizeRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: new TooManyRequestsError(
      "Too many authorization requests",
    ).toResponseObject(),
    ...rateLimitValidation,
  });
  const authorizeHandler = async (
    req: express.Request,
    res: express.Response,
  ) => {
    res.setHeader("Cache-Control", "no-store");
    const params: Record<string, unknown> =
      (req.method === "POST" ? req.body : req.query) ?? {};
    const param = (name: string) =>
      typeof params[name] === "string" ? (params[name] as string) : undefined;

    const clientId = param("client_id");
    const redirectUri = param("redirect_uri");
    let client;
    try {
      client = clientId ? await store.getClient(clientId) : undefined;
    } catch (error) {
      console.error("[oauth] authorize client lookup failed:", error);
      return res
        .status(500)
        .json(new ServerError("Internal Server Error").toResponseObject());
    }
    if (!client) {
      return res
        .status(400)
        .json(new InvalidClientError("Invalid client_id").toResponseObject());
    }
    if (
      !redirectUri ||
      !client.redirect_uris.some((registered) =>
        redirectUriMatches(redirectUri, registered),
      )
    ) {
      return oauthError(
        res,
        new InvalidRequestError(
          redirectUri
            ? "Unregistered redirect_uri"
            : "redirect_uri is required",
        ),
      );
    }

    const state = param("state");
    const fail = (error: OAuthError) => {
      const target = new URL(redirectUri);
      target.searchParams.set("error", error.errorCode);
      target.searchParams.set("error_description", error.message);
      if (state) target.searchParams.set("state", state);
      res.redirect(302, target.href);
    };
    try {
      if (param("response_type") !== "code") {
        throw new UnsupportedResponseTypeError("response_type must be code");
      }
      const codeChallenge = param("code_challenge");
      if (
        param("code_challenge_method") !== "S256" ||
        !codeChallenge ||
        !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)
      ) {
        throw new InvalidRequestError(
          "PKCE is required: code_challenge with code_challenge_method=S256",
        );
      }
      const urls = getOAuthPublicUrls(req);
      const resource = param("resource");
      if (resource !== undefined && !resourceMatches(resource, urls.resource)) {
        throw new InvalidTargetError(`resource must be ${urls.resource}`);
      }
      const scope = param("scope");
      // Never auto-approves: park the validated request and send the browser
      // to the consent page (which handles sign-in first if needed).
      const requestId = await store.createAuthorizationRequest({
        clientId: client.client_id,
        redirectUri,
        codeChallenge,
        state,
        scopes: resolveRequestedScopes(scope ? [scope] : undefined),
        resource: resource !== undefined ? urls.resource : undefined,
      });
      res.redirect(
        302,
        `${CONSENT_PAGE_PATH}?request=${encodeURIComponent(requestId)}`,
      );
    } catch (error) {
      if (error instanceof OAuthError) return fail(error);
      console.error("[oauth] authorize failed:", error);
      return fail(new ServerError("Internal Server Error"));
    }
  };
  app.get("/oauth/authorize", authorizeRateLimit, authorizeHandler);
  app.post("/oauth/authorize", authorizeRateLimit, authorizeHandler);

  // --- Token endpoint ------------------------------------------------------
  app.use("/oauth/token", (req, res, next) => {
    const resource = req.body?.resource;
    if (req.method === "POST" && resource !== undefined) {
      const expected = getOAuthPublicUrls(req).resource;
      if (
        typeof resource !== "string" ||
        !resourceMatches(resource, expected)
      ) {
        return oauthError(
          res,
          new InvalidTargetError(`resource must be ${expected}`),
        );
      }
    }
    next();
  });
  app.use(
    "/oauth/token",
    tokenHandler({
      provider,
      rateLimit: { windowMs: 15 * 60 * 1000, max: 300, ...rateLimitValidation },
    }),
  );

  // --- Dynamic client registration (RFC 7591) ------------------------------
  app.use(
    "/oauth/register",
    clientRegistrationHandler({
      clientsStore,
      rateLimit: { windowMs: 60 * 60 * 1000, max: 50, ...rateLimitValidation },
    }),
  );

  // --- Revocation (RFC 7009) -----------------------------------------------
  app.use(
    "/oauth/revoke",
    revocationHandler({
      provider,
      rateLimit: { windowMs: 15 * 60 * 1000, max: 100, ...rateLimitValidation },
    }),
  );

  return store;
};
