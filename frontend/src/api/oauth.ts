// OAuth consent screen and "Connected agents" (OAuth grants) API. All of
// these need the signed-in browser session; API keys are refused.
import { api } from "./client";

export interface OAuthAuthorizationRequestDetails {
  /** Self-reported by the agent, so only displayed, never trusted. */
  clientName: string | null;
  /** host:port of the loopback redirect, e.g. "127.0.0.1:33418". */
  redirectHost: string;
  scopes: string[];
  expiresAt: string;
}

export interface OAuthGrant {
  id: string;
  clientName: string | null;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export const getOAuthAuthorizationRequest = async (
  requestId: string,
): Promise<OAuthAuthorizationRequestDetails> => {
  const response = await api.get<{
    request: OAuthAuthorizationRequestDetails;
  }>("/auth/oauth/authorization-request", { params: { request: requestId } });
  return response.data.request;
};

export const approveOAuthAuthorizationRequest = async (
  requestId: string,
  readOnly: boolean,
): Promise<{ redirectUrl: string }> => {
  const response = await api.post<{ redirectUrl: string }>(
    "/auth/oauth/authorization-request/approve",
    { request: requestId, readOnly },
  );
  return response.data;
};

export const denyOAuthAuthorizationRequest = async (
  requestId: string,
): Promise<{ redirectUrl: string }> => {
  const response = await api.post<{ redirectUrl: string }>(
    "/auth/oauth/authorization-request/deny",
    { request: requestId },
  );
  return response.data;
};

export const listOAuthGrants = async (): Promise<OAuthGrant[]> => {
  const response = await api.get<{ grants: OAuthGrant[] }>(
    "/auth/oauth/grants",
  );
  return response.data.grants;
};

export const revokeOAuthGrant = async (id: string): Promise<void> => {
  await api.delete(`/auth/oauth/grants/${encodeURIComponent(id)}`);
};
