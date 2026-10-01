import crypto from "node:crypto";
import { env } from "../env";

/**
 * AES-256-GCM for integration credentials stored in the database.
 * The key is derived from NEXTAUTH_SECRET, so a database dump alone never reveals a credential.
 * Changing NEXTAUTH_SECRET makes stored values unreadable — they must then be re-entered.
 */
function key(): Buffer {
  return crypto.createHash("sha256").update(`isolation-integrations-v1:${env().NEXTAUTH_SECRET}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

/** Returns null when the value can't be decrypted (tampered, or NEXTAUTH_SECRET changed). */
export function decryptSecret(stored: string): string | null {
  const [version, iv, tag, ct] = stored.split(".");
  if (version !== "v1" || !iv || !tag || ct === undefined) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
