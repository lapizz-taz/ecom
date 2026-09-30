import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import type { AdminRole } from "@prisma/client";
import { prisma } from "../db";
import { SESSION_COOKIE, verifySession, type SessionPayload } from "./session";
import { LIMITS, clientIp, rateLimit } from "../security/rateLimit";

export * from "./session";

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 12);
}

export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

export function passwordPolicyError(pw: string): string | null {
  if (pw.length < 12) return "Password must be at least 12 characters";
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) return "Password needs upper-case, lower-case and a number";
  return null;
}

/** Session for server components / route handlers; re-checks the user is still active. */
export async function getSession(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  if (!session) return null;
  const user = await prisma.adminUser.findUnique({ where: { id: session.sub }, select: { active: true, role: true, email: true } });
  if (!user || !user.active) return null;
  return { sub: session.sub, email: user.email, role: user.role };
}

/** For pages: redirect to /login if not signed in (or not allowed). */
export async function requirePageSession(role?: AdminRole): Promise<SessionPayload> {
  const s = await getSession();
  if (!s) redirect("/login");
  if (role === "ADMIN" && s.role !== "ADMIN") redirect("/admin?error=forbidden");
  return s;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * For API routes: authentication + authorization + CSRF (same-origin) + rate limiting.
 */
export async function requireApiSession(req: Request, opts: { role?: AdminRole; limitKey?: keyof typeof LIMITS } = {}): Promise<SessionPayload> {
  const s = await getSession();
  if (!s) throw new HttpError(401, "Unauthorized");
  if (opts.role === "ADMIN" && s.role !== "ADMIN") throw new HttpError(403, "Forbidden");
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    const host = (await headers()).get("host");
    if (!origin || !host || new URL(origin).host !== host) throw new HttpError(403, "Cross-origin request blocked");
  }
  const lim = LIMITS[opts.limitKey ?? "adminApiPerMinute"];
  const rl = await rateLimit(`admin:${opts.limitKey ?? "api"}:${s.sub}`, lim.limit, lim.window);
  if (!rl.allowed) throw new HttpError(429, "Too many requests");
  return s;
}

export function apiError(err: unknown) {
  if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err && typeof err === "object" && "issues" in err) {
    return NextResponse.json({ error: "Invalid request", details: (err as { issues: { path: (string | number)[]; message: string }[] }).issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  }
  console.error(JSON.stringify({ level: "error", msg: "api error", error: err instanceof Error ? err.message : String(err) }));
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

export { clientIp };
