import "server-only";
import crypto from "node:crypto";

/**
 * Password protection for /admin. Set ADMIN_PASSWORD in your environment.
 * A signed, http-only cookie keeps you logged in for 12 hours.
 */
export const ADMIN_COOKIE = "unibee_admin";
const MAX_AGE_SEC = 12 * 60 * 60;

const secret = () => process.env.ADMIN_SESSION_SECRET || `unibee:${process.env.ADMIN_PASSWORD || ""}`;
const sign = (payload: string) => crypto.createHmac("sha256", secret()).update(payload).digest("base64url");

export const adminConfigured = () => Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 8);

export function checkPassword(input: string): boolean {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!adminConfigured()) return false;
  const a = crypto.createHash("sha256").update(input).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createSession(now = Date.now()) {
  const exp = String(Math.floor(now / 1000) + MAX_AGE_SEC);
  return { value: `${exp}.${sign(exp)}`, maxAge: MAX_AGE_SEC };
}

export function verifySession(value: string | undefined, now = Date.now()): boolean {
  if (!value || !adminConfigured()) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig) return false;
  const expected = sign(exp);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(exp) * 1000 > now;
}

/** Reads and verifies the admin cookie from a request. */
export function isAdminRequest(req: Request): boolean {
  const cookie = req.headers.get("cookie") || "";
  const value = cookie
    .split(/;\s*/)
    .find((c) => c.startsWith(`${ADMIN_COOKIE}=`))
    ?.slice(ADMIN_COOKIE.length + 1);
  return verifySession(value ? decodeURIComponent(value) : undefined);
}

/** Blocks cross-site form posts (CSRF): the Origin header must match this site. */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // same-origin fetches from older browsers may omit it; the cookie is SameSite=Lax anyway
  try {
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
