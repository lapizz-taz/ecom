import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, hashPassword, passwordPolicyError, requireApiSession, verifyPassword } from "@/lib/auth";
import { rateLimit } from "@/lib/security/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) });

/** Any signed-in staff member: change your own password (requires the current one). */
export async function POST(req: Request) {
  try {
    const session = await requireApiSession(req);
    // Few attempts, so a stolen session can't be used to guess the current password.
    const rl = await rateLimit(`password-change:${session.sub}`, 5, 900);
    if (!rl.allowed) return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });

    const body = schema.parse(await req.json());
    const user = await prisma.adminUser.findUnique({ where: { id: session.sub } });
    if (!user || !(await verifyPassword(body.currentPassword, user.passwordHash))) {
      return NextResponse.json({ error: "Your current password is wrong." }, { status: 400 });
    }
    const pwErr = passwordPolicyError(body.newPassword);
    if (pwErr) return NextResponse.json({ error: pwErr }, { status: 400 });
    if (body.newPassword === body.currentPassword) return NextResponse.json({ error: "Choose a password different from the current one." }, { status: 400 });

    await prisma.adminUser.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword) } });
    await prisma.auditLog.create({ data: { actor: user.email, action: "account.change_password" } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
