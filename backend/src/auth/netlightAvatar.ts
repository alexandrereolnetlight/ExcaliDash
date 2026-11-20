/**
 * Resolves a user's profile picture URL from the Netlight API at OIDC login.
 *
 * Only the (public, API-cached) photo URL is ever stored; the image itself is
 * never fetched or proxied by the backend.
 *
 * Return contract of resolveNetlightAvatarUrl:
 *   - undefined: unknown (lookup disabled/failed) -> keep the existing value
 *   - null:      confirmed "no photo"
 *   - string:    sanitized photo URL
 */
import { config } from "../config";

const REQUEST_TIMEOUT_MS = 3000;
const COLLEAGUES_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_AVATAR_URL_LENGTH = 2048;
const ALLOWED_PHOTO_HOSTNAME = "photos.api.prd.aws.netlight.com";

type NetlightPhotos = {
  small?: unknown;
  medium?: unknown;
  large?: unknown;
} | null;

type NetlightPerson = {
  azureUserId?: unknown;
  email?: { short?: unknown; long?: unknown } | null;
  photos?: NetlightPhotos;
};

type ResolveNetlightAvatarUrlInput = {
  accessToken: string | null | undefined;
  azureUserId: string | null | undefined;
  email: string | null | undefined;
};

let colleaguesCache: { fetchedAt: number; colleagues: unknown[] } | null = null;

/** Test-only: clears the module-level /colleagues cache. */
export const __resetNetlightAvatarCacheForTests = (): void => {
  colleaguesCache = null;
};

/**
 * Accepts only https URLs on the Netlight photo host. The API's placeholder
 * image (…/default.jpg) means "no photo" and maps to null, as does anything
 * invalid.
 */
export const sanitizeNetlightPhotoUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_AVATAR_URL_LENGTH) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== ALLOWED_PHOTO_HOSTNAME) return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.pathname.toLowerCase().endsWith("/default.jpg")) return null;
  const normalized = parsed.toString();
  return normalized.length > MAX_AVATAR_URL_LENGTH ? null : normalized;
};

const pickPhotoUrl = (person: NetlightPerson): string | null => {
  const photos = person.photos;
  if (!photos || typeof photos !== "object") return null;
  const candidate = photos.medium ?? photos.small ?? photos.large;
  return sanitizeNetlightPhotoUrl(candidate);
};

const requestNetlightApi = (
  baseUrl: string,
  path: string,
  accessToken: string,
): Promise<Response> =>
  fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const loadColleagues = async (
  baseUrl: string,
  accessToken: string,
): Promise<unknown[] | null> => {
  const now = Date.now();
  if (
    colleaguesCache &&
    now - colleaguesCache.fetchedAt < COLLEAGUES_CACHE_TTL_MS
  ) {
    return colleaguesCache.colleagues;
  }
  try {
    const response = await requestNetlightApi(
      baseUrl,
      "/colleagues",
      accessToken,
    );
    if (!response.ok) {
      console.warn(
        `Netlight avatar: GET /colleagues failed with status ${response.status}`,
      );
      return null;
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      console.warn(
        "Netlight avatar: GET /colleagues returned a non-array body",
      );
      return null;
    }
    colleaguesCache = { fetchedAt: now, colleagues: body };
    return body;
  } catch (error) {
    console.warn(
      `Netlight avatar: GET /colleagues request failed (${describeError(error)})`,
    );
    return null;
  }
};

const equalsIgnoreCase = (value: unknown, expected: string): boolean =>
  typeof value === "string" && value.trim().toLowerCase() === expected;

const findColleague = (
  colleagues: unknown[],
  azureUserId: string | null | undefined,
  email: string | null | undefined,
): NetlightPerson | null => {
  const people = colleagues.filter(
    (entry): entry is NetlightPerson =>
      Boolean(entry) && typeof entry === "object",
  );
  const normalizedId = azureUserId?.trim().toLowerCase();
  if (normalizedId) {
    const byId = people.find((person) =>
      equalsIgnoreCase(person.azureUserId, normalizedId),
    );
    if (byId) return byId;
  }
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) {
    const byEmail = people.find(
      (person) =>
        Boolean(person.email) &&
        typeof person.email === "object" &&
        (equalsIgnoreCase(person.email?.short, normalizedEmail) ||
          equalsIgnoreCase(person.email?.long, normalizedEmail)),
    );
    if (byEmail) return byEmail;
  }
  return null;
};

const resolveFromColleagues = async (
  baseUrl: string,
  input: ResolveNetlightAvatarUrlInput & { accessToken: string },
): Promise<string | null | undefined> => {
  const colleagues = await loadColleagues(baseUrl, input.accessToken);
  if (!colleagues) return undefined;
  const person = findColleague(colleagues, input.azureUserId, input.email);
  if (!person) return undefined;
  return pickPhotoUrl(person);
};

export const resolveNetlightAvatarUrl = async (
  input: ResolveNetlightAvatarUrlInput,
): Promise<string | null | undefined> => {
  try {
    const baseUrl = config.netlightApi.url;
    const accessToken = input.accessToken?.trim();
    if (!baseUrl || !accessToken) return undefined;

    let meResponse: Response;
    try {
      meResponse = await requestNetlightApi(baseUrl, "/me", accessToken);
    } catch (error) {
      console.warn(
        `Netlight avatar: GET /me request failed (${describeError(error)})`,
      );
      return undefined;
    }

    if (meResponse.status === 401 || meResponse.status === 403) {
      // The "Public" scope may not grant Me.Read; fall back to /colleagues.
      return await resolveFromColleagues(baseUrl, { ...input, accessToken });
    }
    if (!meResponse.ok) {
      console.warn(
        `Netlight avatar: GET /me failed with status ${meResponse.status}`,
      );
      return undefined;
    }
    const body: unknown = await meResponse.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      console.warn("Netlight avatar: GET /me returned an unexpected body");
      return undefined;
    }
    return pickPhotoUrl(body as NetlightPerson);
  } catch (error) {
    console.warn(`Netlight avatar: lookup failed (${describeError(error)})`);
    return undefined;
  }
};
