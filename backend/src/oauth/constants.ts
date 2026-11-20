import type express from "express";
import { DEFAULT_API_KEY_SCOPES } from "../auth/apiKeys";
import { resolvePublicOrigin } from "../mcp/publicOrigin";

export const OAUTH_SCOPES: readonly string[] = DEFAULT_API_KEY_SCOPES;
export const OAUTH_READ_ONLY_SCOPES: readonly string[] = [
  "drawings:read",
  "collections:read",
];

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;
export const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;

export const REFRESH_TOKEN_PREFIX = "exr_";

/** SPA route that renders the consent screen. */
export const CONSENT_PAGE_PATH = "/oauth/consent";

/**
 * Public URLs of the authorization server and the MCP resource. The bundled
 * nginx serves the backend under /api (prefix stripped) and forwards
 * /.well-known/oauth-* unchanged. The origin comes from FRONTEND_URL (the
 * entry matching the request host, else the first one), never from an
 * arbitrary Host header when FRONTEND_URL is configured.
 */
export const getOAuthPublicUrls = (req: express.Request) => {
  const origin = resolvePublicOrigin(req);
  return {
    origin,
    issuer: origin,
    resource: `${origin}/api/mcp`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource/api/mcp`,
    authorizationEndpoint: `${origin}/api/oauth/authorize`,
    tokenEndpoint: `${origin}/api/oauth/token`,
    registrationEndpoint: `${origin}/api/oauth/register`,
    revocationEndpoint: `${origin}/api/oauth/revoke`,
  };
};

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, "");

/** RFC 8707: a requested resource must name this MCP endpoint. */
export const resourceMatches = (requested: string, expected: string) => {
  try {
    return (
      stripTrailingSlash(new URL(requested).href) ===
      stripTrailingSlash(new URL(expected).href)
    );
  } catch {
    return false;
  }
};
