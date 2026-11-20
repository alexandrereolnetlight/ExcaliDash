import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const netlightApi = vi.hoisted(() => ({
  url: "https://api.example.netlight.test" as string | null,
}));

vi.mock("../config", () => ({ config: { netlightApi } }));

import {
  __resetNetlightAvatarCacheForTests,
  resolveNetlightAvatarUrl,
  sanitizeNetlightPhotoUrl,
} from "../auth/netlightAvatar";

const API_URL = "https://api.example.netlight.test";
const PHOTO_HOST = "https://photos.api.prd.aws.netlight.com";
const TOKEN = "secret-access-token";

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const person = (
  overrides: Partial<{
    azureUserId: string;
    short: string;
    long: string;
    photos: Record<string, string> | null;
  }> = {},
) => ({
  azureUserId: overrides.azureUserId ?? "00000000-0000-0000-0000-000000000001",
  name: "Jane Doe",
  email: {
    short: overrides.short ?? "jado@netlight.com",
    long: overrides.long ?? "jane.doe@netlight.com",
  },
  photos:
    overrides.photos === undefined
      ? {
          small: `${PHOTO_HOST}/small/jado.jpg`,
          medium: `${PHOTO_HOST}/medium/jado.jpg`,
          large: `${PHOTO_HOST}/large/jado.jpg`,
        }
      : overrides.photos,
});

const baseInput = {
  accessToken: TOKEN,
  azureUserId: "00000000-0000-0000-0000-000000000001",
  email: "jane.doe@netlight.com",
};

describe("resolveNetlightAvatarUrl", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    netlightApi.url = API_URL;
    __resetNetlightAvatarCacheForTests();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the medium photo from /me with bearer auth", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(person()));

    await expect(resolveNetlightAvatarUrl(baseInput)).resolves.toBe(
      `${PHOTO_HOST}/medium/jado.jpg`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_URL}/me`);
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect((init?.headers as Record<string, string>).Accept).toBe(
      "application/json",
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to small, then large photo sizes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(person({ photos: { large: `${PHOTO_HOST}/large/x.jpg` } })),
    );
    await expect(resolveNetlightAvatarUrl(baseInput)).resolves.toBe(
      `${PHOTO_HOST}/large/x.jpg`,
    );
  });

  it("maps the default.jpg placeholder to null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(person({ photos: { medium: `${PHOTO_HOST}/default.jpg` } })),
    );
    await expect(resolveNetlightAvatarUrl(baseInput)).resolves.toBeNull();
  });

  it("maps missing photos to null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(person({ photos: null })),
    );
    await expect(resolveNetlightAvatarUrl(baseInput)).resolves.toBeNull();
  });

  it("rejects photo URLs outside the allowlisted host", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        person({ photos: { medium: "https://evil.example.com/medium/x.jpg" } }),
      ),
    );
    await expect(resolveNetlightAvatarUrl(baseInput)).resolves.toBeNull();
  });

  it("falls back to /colleagues on 403 and matches by azureUserId", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/me")) return jsonResponse({}, 403);
        return jsonResponse([
          person({
            azureUserId: "other-id",
            short: "abcd@netlight.com",
            long: "someone.else@netlight.com",
            photos: { medium: `${PHOTO_HOST}/medium/other.jpg` },
          }),
          person({
            azureUserId: "00000000-0000-0000-0000-00000000000A",
            short: "xxxx@netlight.com",
            long: "not.matching@netlight.com",
            photos: { medium: `${PHOTO_HOST}/medium/by-id.jpg` },
          }),
        ]);
      });

    await expect(
      resolveNetlightAvatarUrl({
        ...baseInput,
        azureUserId: "00000000-0000-0000-0000-00000000000a",
      }),
    ).resolves.toBe(`${PHOTO_HOST}/medium/by-id.jpg`);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${API_URL}/me`,
      `${API_URL}/colleagues`,
    ]);
  });

  it("falls back to /colleagues on 401 and matches by email", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/me")) return jsonResponse({}, 401);
      return jsonResponse([
        person({
          azureUserId: "someone-else",
          short: "JADO@netlight.com",
          long: "jane.doe@netlight.com",
          photos: { medium: `${PHOTO_HOST}/medium/by-email.jpg` },
        }),
      ]);
    });

    await expect(
      resolveNetlightAvatarUrl({
        ...baseInput,
        azureUserId: null,
        email: "jado@netlight.com",
      }),
    ).resolves.toBe(`${PHOTO_HOST}/medium/by-email.jpg`);
  });

  it("caches successful /colleagues responses", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/me")) return jsonResponse({}, 403);
        return jsonResponse([person()]);
      });

    await resolveNetlightAvatarUrl(baseInput);
    await resolveNetlightAvatarUrl(baseInput);
    const colleagueCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/colleagues"),
    );
    expect(colleagueCalls).toHaveLength(1);
  });

  it("returns undefined when the colleague is not found", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/me")) return jsonResponse({}, 403);
      return jsonResponse([
        person({
          azureUserId: "x",
          short: "x@netlight.com",
          long: "x.y@netlight.com",
        }),
      ]);
    });
    await expect(resolveNetlightAvatarUrl(baseInput)).resolves.toBeUndefined();
  });

  it("returns undefined without config or access token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    netlightApi.url = null;
    await expect(resolveNetlightAvatarUrl(baseInput)).resolves.toBeUndefined();

    netlightApi.url = API_URL;
    await expect(
      resolveNetlightAvatarUrl({ ...baseInput, accessToken: undefined }),
    ).resolves.toBeUndefined();
    await expect(
      resolveNetlightAvatarUrl({ ...baseInput, accessToken: "" }),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns undefined on fetch errors and never logs the token", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed"),
    );
    await expect(resolveNetlightAvatarUrl(baseInput)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    for (const call of warnSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
  });

  it("returns undefined on unexpected /me statuses and failed fallbacks", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({}, 500));
    await expect(resolveNetlightAvatarUrl(baseInput)).resolves.toBeUndefined();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/me")) return jsonResponse({}, 403);
      throw new TypeError("network down");
    });
    await expect(resolveNetlightAvatarUrl(baseInput)).resolves.toBeUndefined();
  });
});

describe("sanitizeNetlightPhotoUrl", () => {
  it("accepts https photo URLs on the allowlisted host", () => {
    expect(sanitizeNetlightPhotoUrl(`${PHOTO_HOST}/medium/a.jpg`)).toBe(
      `${PHOTO_HOST}/medium/a.jpg`,
    );
  });

  it("rejects other protocols, hosts, oversize values and non-strings", () => {
    expect(
      sanitizeNetlightPhotoUrl("http://photos.api.prd.aws.netlight.com/a.jpg"),
    ).toBeNull();
    expect(
      sanitizeNetlightPhotoUrl(
        "https://photos.api.prd.aws.netlight.com.evil.com/a.jpg",
      ),
    ).toBeNull();
    expect(sanitizeNetlightPhotoUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeNetlightPhotoUrl("not a url")).toBeNull();
    expect(
      sanitizeNetlightPhotoUrl(`${PHOTO_HOST}/${"a".repeat(2100)}.jpg`),
    ).toBeNull();
    expect(sanitizeNetlightPhotoUrl(42)).toBeNull();
    expect(sanitizeNetlightPhotoUrl(`${PHOTO_HOST}/default.jpg`)).toBeNull();
  });
});
