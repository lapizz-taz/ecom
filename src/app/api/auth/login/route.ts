import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { SESSION_COOKIE, apiError, clientIp, sessionCookieOptions, signSession, verifyPassword } from "@/lib/auth";
import { LIMITS, rateLimit } from "@/lib/security/rateLimit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) });
// Constant-time-ish dummy hash so unknown emails take as long as wrong passwords.
const DUMMY_HASH = "$2b$12$twuLDFkOIlnWBO7uXFYUT.7HsNL1tO86UQHhKbzL5CM4szTlTQ8aa";

export async function POST(req: Request) {
  try {
    const ip = clientIp(req.headers);
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (origin && host && new URL(origin).host !== host) return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });

    const body = schema.parse(await req.json());
    const byIp = await rateLimit(`login-ip:${ip}`, LIMITS.loginPerIp15m.limit, LIMITS.loginPerIp15m.window);
    const byEmail = await rateLimit(`login-email:${body.email}`, LIMITS.loginPerEmail15m.limit, LIMITS.loginPerEmail15m.window);
    if (!byIp.allowed || !byEmail.allowed) {
      return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
    }
    const user = await prisma.adminUser.findUnique({ where: { email: body.email } });
    const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || !user.active) {
      logger.warn("admin login failed", { ip });
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }
    await prisma.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await prisma.auditLog.create({ data: { actor: user.email, action: "auth.login", detail: { ip } } });
    const token = await signSession({ sub: user.id, email: user.email, role: user.role });
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions);
    return res;
  } catch (err) {
    return apiError(err);
  }
}
