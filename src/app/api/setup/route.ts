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
  name: z.string().trim().max(100).optional(),
  password: z.string().min(1).max(200),
});

/**
 * One-time creation of the first ADMIN account from the browser.
 * Only works while no admin exists, and requires the setup key (= the NEXTAUTH_SECRET value
 * from the hosting environment), so a stranger who finds the URL first cannot claim it.
 */
export async function POST(req: Request) {
  try {
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (origin && host && new URL(origin).host !== host) return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });

    const ip = clientIp(req.headers);
    const rl = await rateLimit(`setup-ip:${ip}`, 5, 900);
    if (!rl.allowed) return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });

    const status = await getSetupStatus();
    const problem = describeProblem(status);
    if (problem) return NextResponse.json({ error: problem }, { status: 503 });
    if (status.adminExists) return NextResponse.json({ error: "Setup is already complete. Sign in at /login." }, { status: 409 });

    const body = schema.parse(await req.json());
    if (!safeEqual(body.setupKey.trim(), process.env.NEXTAUTH_SECRET)) {
      logger.warn("setup attempt with wrong key", { ip });
      return NextResponse.json({ error: "Setup key is wrong. Copy the exact NEXTAUTH_SECRET value from your environment variables." }, { status: 401 });
    }
    const expected = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    if (expected && expected !== body.email) {
      return NextResponse.json({ error: "Email must match the ADMIN_EMAIL environment variable." }, { status: 400 });
    }
    const pwErr = passwordPolicyError(body.password);
    if (pwErr) return NextResponse.json({ error: pwErr }, { status: 400 });

    const passwordHash = await hashPassword(body.password);
    const created = await prisma.$transaction(async (tx) => {
      if ((await tx.adminUser.count({ where: { role: "ADMIN" } })) > 0) return null;
      return tx.adminUser.upsert({
        where: { email: body.email },
        create: { email: body.email, name: body.name || "Owner", role: "ADMIN", passwordHash },
        update: { role: "ADMIN", passwordHash, active: true },
      });
    });
    if (!created) return NextResponse.json({ error: "Setup is already complete. Sign in at /login." }, { status: 409 });
    await prisma.auditLog.create({ data: { actor: created.email, action: "setup.first_admin", detail: { ip } } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
