/**
 * Loopback access to this backend's own REST API, used by the MCP tools so
 * they go through exactly the same auth, sharing rules, validation, version
 * guard and live broadcast as any other API client.
 */
import crypto from "crypto";
import type { AddressInfo, Server } from "net";
import type { Request } from "express";
import { config } from "../config";

let listeningBaseUrl: string | null = null;
let overrideBaseUrl: string | null = null;

const formatHost = (address: string): string => {
  if (address === "0.0.0.0" || address === "") return "127.0.0.1";
  if (address === "::" || address === "::0") return "[::1]";
  if (address.startsWith("::ffff:")) return address.slice("::ffff:".length);
  return address.includes(":") ? `[${address}]` : address;
};

/**
 * Remember where the HTTP server actually listens. Called from the server's
 * "listening" event, so it also covers tests that listen on an ephemeral port.
 */
export const recordListeningAddress = (server: Server): void => {
  const address = server.address();
  if (!address || typeof address === "string") return;
  const { address: host, port } = address as AddressInfo;
  listeningBaseUrl = `http://${formatHost(host)}:${port}`;
};

/** Test hook: force the base URL (pass null to restore auto-detection). */
export const setInternalApiBaseUrl = (url: string | null): void => {
  overrideBaseUrl = url ? url.replace(/\/+$/, "") : null;
};

export const getInternalApiBaseUrl = (): string =>
  overrideBaseUrl ?? listeningBaseUrl ?? `http://127.0.0.1:${config.port}`;

// Per-process secret proving a request was made by the MCP adapter itself.
// Such requests already passed the HTTPS policy and the rate limiter as the
// original /mcp call, so they are not counted or redirected a second time.
const INTERNAL_REQUEST_HEADER = "x-excalidash-internal";
const internalRequestSecret = crypto.randomBytes(32).toString("hex");

export const isInternalApiRequest = (
  req: Pick<Request, "headers">,
): boolean => {
  const raw = req.headers[INTERNAL_REQUEST_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (
    typeof value !== "string" ||
    value.length !== internalRequestSecret.length
  )
    return false;
  return crypto.timingSafeEqual(
    Buffer.from(value),
    Buffer.from(internalRequestSecret),
  );
};

export type InternalApiResponse = {
  ok: boolean;
  status: number;
  body: any;
};

export type InternalApiClient = {
  request: (
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ) => Promise<InternalApiResponse>;
};

const REQUEST_TIMEOUT_MS = 30_000;

export const createInternalApiClient = (
  apiKey: string,
  baseUrl: string = getInternalApiBaseUrl(),
): InternalApiClient => ({
  request: async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        [INTERNAL_REQUEST_HEADER]: internalRequestSecret,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Never follow a redirect: it would carry the key to another URL.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let parsed: any = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { message: text.slice(0, 500) };
      }
    }
    return { ok: response.ok, status: response.status, body: parsed };
  },
});
