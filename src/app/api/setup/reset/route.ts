import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, clientIp, hashPassword, passwordPolicyError } from "@/lib/auth";
import { rateLimit } from "@/lib/security/rateLimit";
import { safeEqual } from "@/lib/security/signature";
import { describeProblem, getSetupStatus } from "@/lib/setup";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  setupKey: z.string().min(1).max(500),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

/**
 * "Forgot the password?" for an ADMIN account, from the /setup page.
 * Requires the setup key (= the NEXTAUTH_SECRET value). That secret already signs every login
 * session, so whoever holds it could act as an admin anyway — this grants nothing new.
 */
export async function POST(req: Request) {
  try {
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (origin && host && new URL(origin).host !== host) return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });

    const ip = clientIp(req.headers);
    const rl = await rateLimit(`setup-reset-ip:${ip}`, 5, 900);
    if (!rl.allowed) return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });

    const status = await getSetupStatus();
    const problem = describeProblem(status);
    if (problem) return NextResponse.json({ error: problem }, { status: 503 });
    if (!status.adminExists) return NextResponse.json({ error: "No admin account exists yet — create one with first-time setup." }, { status: 409 });

    const body = schema.parse(await req.json());
    if (!safeEqual(body.setupKey.trim(), process.env.NEXTAUTH_SECRET)) {
      logger.warn("admin password reset attempt with wrong key", { ip });
      return NextResponse.json({ error: "Setup key is wrong. Copy the exact NEXTAUTH_SECRET value from your environment variables." }, { status: 401 });
    }
    const pwErr = passwordPolicyError(body.password);
    if (pwErr) return NextResponse.json({ error: pwErr }, { status: 400 });

    const user = await prisma.adminUser.findUnique({ where: { email: body.email } });
    if (!user || user.role !== "ADMIN") return NextResponse.json({ error: "There's no admin account with that email." }, { status: 404 });

    await prisma.adminUser.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.password), active: true } });
    // Lift a sign-in lockout from earlier wrong guesses so the new password works straight away.
    await prisma.rateLimit.deleteMany({ where: { key: `login-email:${user.email}` } });
    await prisma.auditLog.create({ data: { actor: user.email, action: "setup.reset_admin_password", detail: { ip } } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
