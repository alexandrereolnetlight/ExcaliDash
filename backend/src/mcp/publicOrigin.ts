import type express from "express";
import { config } from "../config";

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
 * Public origin of this deployment for the client that sent `req`: the
 * FRONTEND_URL entry that matches the host the client called (several may be
 * configured), else the first entry. Only without FRONTEND_URL does it fall
 * back to the request's own Host header.
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
