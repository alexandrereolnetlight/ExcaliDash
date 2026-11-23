/**
 * AES-256-GCM encryption for personal LLM proxy keys at rest. The user id is
 * bound in as additional authenticated data, so a ciphertext copied onto
 * another user's row does not decrypt.
 *
 * Format: "v1:<iv base64url>:<auth tag base64url>:<ciphertext base64url>".
 */
import crypto from "crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const encryptSecret = (
  plaintext: string,
  key: Buffer,
  associatedData: string,
): string => {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
};

/** Returns null when the value is malformed, tampered with or under another key. */
export const decryptSecret = (
  encoded: string,
  key: Buffer,
  associatedData: string,
): string | null => {
  const parts = encoded.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION || key.length !== 32) {
    return null;
  }
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
};
