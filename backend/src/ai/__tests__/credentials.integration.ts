import crypto from "crypto";
import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { parseKeyEncryptionKey } from "../../config/ai";
import { decryptSecret, encryptSecret } from "../crypto";
import {
  keyHintOf,
  PROXY_KEY_PATTERN,
  resolveAiCredential,
} from "../credentials";
import { describeProxyError } from "../proxy";
import { buildAgentMessages } from "../agent";
import { buildContextBlock } from "../prompt";

const KEY = crypto.randomBytes(32);
const OTHER_KEY = crypto.randomBytes(32);
const PERSONAL = "sk-personal-1234abcd";

describe("personal key encryption", () => {
  it("round-trips and never stores the plaintext", () => {
    const encrypted = encryptSecret(PERSONAL, KEY, "user-1");
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(encrypted).not.toContain(PERSONAL);
    expect(decryptSecret(encrypted, KEY, "user-1")).toBe(PERSONAL);
  });

  it("uses a fresh IV for every encryption", () => {
    expect(encryptSecret(PERSONAL, KEY, "user-1")).not.toBe(
      encryptSecret(PERSONAL, KEY, "user-1"),
    );
  });

  it("rejects another key, another user and tampered ciphertext", () => {
    const encrypted = encryptSecret(PERSONAL, KEY, "user-1");
    expect(decryptSecret(encrypted, OTHER_KEY, "user-1")).toBeNull();
    expect(decryptSecret(encrypted, KEY, "user-2")).toBeNull();
    const parts = encrypted.split(":");
    const ciphertext = Buffer.from(parts[3], "base64url");
    ciphertext[0] ^= 0xff;
    parts[3] = ciphertext.toString("base64url");
    expect(decryptSecret(parts.join(":"), KEY, "user-1")).toBeNull();
    expect(decryptSecret("garbage", KEY, "user-1")).toBeNull();
    expect(decryptSecret("v2:a:b:c", KEY, "user-1")).toBeNull();
  });

  it("parses 32-byte encryption keys given as hex or base64", () => {
    expect(parseKeyEncryptionKey(KEY.toString("hex"))?.equals(KEY)).toBe(true);
    expect(parseKeyEncryptionKey(KEY.toString("base64"))?.equals(KEY)).toBe(
      true,
    );
    expect(parseKeyEncryptionKey(KEY.toString("base64url"))?.equals(KEY)).toBe(
      true,
    );
    expect(parseKeyEncryptionKey("too-short")).toBeNull();
    expect(
      parseKeyEncryptionKey(crypto.randomBytes(16).toString("base64")),
    ).toBeNull();
    expect(parseKeyEncryptionKey("not base64 at all!")).toBeNull();
  });
});

describe("credential resolution", () => {
  const stored = { keyEncrypted: encryptSecret(PERSONAL, KEY, "user-1") };

  it("prefers the personal key", () => {
    const resolved = resolveAiCredential({
      userId: "user-1",
      stored,
      sharedKey: "sk-shared",
      encryptionKey: KEY,
    });
    expect(resolved).toMatchObject({
      ok: true,
      source: "personal",
      key: PERSONAL,
      personalKeyUnreadable: false,
    });
  });

  it("falls back to the shared key", () => {
    expect(
      resolveAiCredential({
        userId: "user-1",
        stored: null,
        sharedKey: "sk-shared",
        encryptionKey: KEY,
      }),
    ).toMatchObject({ ok: true, source: "shared", key: "sk-shared" });
  });

  it("falls back to the shared key when the personal key is unreadable", () => {
    for (const encryptionKey of [OTHER_KEY, null]) {
      expect(
        resolveAiCredential({
          userId: "user-1",
          stored,
          sharedKey: "sk-shared",
          encryptionKey,
        }),
      ).toMatchObject({
        ok: true,
        source: "shared",
        personalKeyUnreadable: true,
      });
    }
  });

  it("explains how to fix a missing credential", () => {
    const withPersonal = resolveAiCredential({
      userId: "user-1",
      stored: null,
      sharedKey: null,
      encryptionKey: KEY,
    });
    expect(withPersonal.ok).toBe(false);
    expect(withPersonal.message).toContain("AI_PROXY_API_KEY");
    expect(withPersonal.message).toContain("Settings");
    const withoutPersonal = resolveAiCredential({
      userId: "user-1",
      stored: null,
      sharedKey: null,
      encryptionKey: null,
    });
    expect(withoutPersonal.message).toContain("AI_PROXY_API_KEY");
    expect(withoutPersonal.message).not.toContain("Settings");
  });

  it("accepts sk- keys only and keeps a four character hint", () => {
    expect(PROXY_KEY_PATTERN.test("sk-abcd1234")).toBe(true);
    expect(PROXY_KEY_PATTERN.test("pk-abcd1234")).toBe(false);
    expect(PROXY_KEY_PATTERN.test("sk-ab cd1234")).toBe(false);
    expect(PROXY_KEY_PATTERN.test("sk-")).toBe(false);
    expect(keyHintOf("sk-abcdef9876")).toBe("9876");
  });
});

describe("proxy error messages", () => {
  const headers = new Headers();
  const make = (status: number) =>
    Anthropic.APIError.generate(
      status,
      { type: "error", error: { type: "x", message: "detail sk-secret" } },
      undefined,
      headers,
    );

  it("maps statuses to friendly messages without leaking keys", () => {
    const ctx = { model: "claude-opus-5-5", source: "personal" as const };
    expect(describeProxyError(make(401), ctx)).toMatchObject({
      code: "key_rejected",
    });
    expect(describeProxyError(make(401), ctx).message).toContain("Settings");
    expect(
      describeProxyError(make(401), { ...ctx, source: "shared" }).message,
    ).toContain("AI_PROXY_API_KEY");
    expect(describeProxyError(make(403), ctx).message).toContain(
      "claude-opus-5-5",
    );
    expect(describeProxyError(make(429), ctx).code).toBe("rate_limited");
    expect(describeProxyError(make(503), ctx).code).toBe("upstream_error");
    const rejected = describeProxyError(make(400), ctx);
    expect(rejected.code).toBe("request_rejected");
    expect(rejected.message).not.toContain("sk-secret");
    expect(describeProxyError(new Error("boom"), ctx).code).toBe(
      "internal_error",
    );
  });
});

describe("agent messages", () => {
  it("puts the context in the latest user turn and starts with a user turn", () => {
    const context = buildContextBlock({
      drawingId: "d-1",
      selectedElementIds: ["a", "b"],
      viewport: { x: 10, y: 20, width: 800, height: 600, zoom: 1.5 },
    });
    expect(context).toContain("Current drawing id: d-1");
    expect(context).toContain("Selected element ids: a, b");
    expect(context).toContain("x 10..810, y 20..620 (zoom 1.5)");
    const messages = buildAgentMessages(
      [
        { role: "assistant", content: "stray greeting" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "" },
        { role: "assistant", content: "hello" },
      ],
      context,
      "add a box",
    );
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(messages[2].content).toEqual([
      { type: "text", text: context },
      { type: "text", text: "add a box" },
    ]);
    expect(
      buildContextBlock({ drawingId: "d-2", selectedElementIds: [] }),
    ).toContain("Selected element ids: none");
  });
});
