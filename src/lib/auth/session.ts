import { SignJWT, jwtVerify } from "jose";
import type { AdminRole } from "@prisma/client";

export const SESSION_COOKIE = "iso_admin_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h

export interface SessionPayload {
  sub: string; // admin user id
  email: string;
  role: AdminRole;
}

function secretKey(): Uint8Array {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s || s.length < 32) throw new Error("NEXTAUTH_SECRET must be set (32+ chars)");
  return new TextEncoder().encode(s);
}

export async function signSession(p: SessionPayload): Promise<string> {
  return new SignJWT({ email: p.email, role: p.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(p.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .setIssuer("isolation-admin")
    .sign(secretKey());
}

/** Edge-safe verification (used by middleware and server code). */
export async function verifySession(token: string | undefined | null): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: "isolation-admin", algorithms: ["HS256"] });
    if (!payload.sub || typeof payload.email !== "string" || (payload.role !== "ADMIN" && payload.role !== "AGENT")) return null;
    return { sub: payload.sub, email: payload.email, role: payload.role };
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};
