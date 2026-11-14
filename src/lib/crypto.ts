import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DEFAULT_LOCALE } from "@/i18n/config";
import { translator } from "@/i18n/translate";

// Meta tokens are encrypted with AES-256-GCM before being stored in the DB. Key from ENCRYPTION_KEY.
function key(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error("ENCRYPTION_KEY is missing from .env");
  return createHash("sha256").update(secret).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decrypt(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 3) throw new Error(translator(DEFAULT_LOCALE)("settings.crypto.badToken"));
  const [iv, tag, data] = parts.map((s) => Buffer.from(s, "base64"));
  // authTagLength fixed at 16 bytes: truncated tags are rejected.
  const decipher = createDecipheriv("aes-256-gcm", key(), iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
