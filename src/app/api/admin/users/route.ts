import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, hashPassword, passwordPolicyError, requireApiSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().max(100).optional(),
  role: z.enum(["ADMIN", "AGENT"]),
  password: z.string().min(12).max(200),
});
const updateSchema = z.object({
  id: z.string().min(5).max(40),
  role: z.enum(["ADMIN", "AGENT"]).optional(),
  active: z.boolean().optional(),
  password: z.string().min(12).max(200).optional(),
});

export async function GET(req: Request) {
  try {
    await requireApiSession(req, { role: "ADMIN" });
    const users = await prisma.adminUser.findMany({
      select: { id: true, email: true, name: true, role: true, active: true, lastLoginAt: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({ users });
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireApiSession(req, { role: "ADMIN" });
    const body = createSchema.parse(await req.json());
    const pwErr = passwordPolicyError(body.password);
    if (pwErr) return NextResponse.json({ error: pwErr }, { status: 400 });
    const user = await prisma.adminUser.create({
      data: { email: body.email, name: body.name, role: body.role, passwordHash: await hashPassword(body.password) },
      select: { id: true, email: true, role: true },
    });
    await prisma.auditLog.create({ data: { actor: session.email, action: "user.create", target: user.email } });
    return NextResponse.json({ user });
  } catch (err) {
    return apiError(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await requireApiSession(req, { role: "ADMIN" });
    const body = updateSchema.parse(await req.json());
    if (body.id === session.sub && (body.active === false || body.role === "AGENT")) {
      return NextResponse.json({ error: "You cannot deactivate or demote yourself" }, { status: 400 });
    }
    if (body.password) {
      const pwErr = passwordPolicyError(body.password);
      if (pwErr) return NextResponse.json({ error: pwErr }, { status: 400 });
    }
    const user = await prisma.adminUser.update({
      where: { id: body.id },
      data: { role: body.role, active: body.active, ...(body.password ? { passwordHash: await hashPassword(body.password) } : {}) },
      select: { id: true, email: true, role: true, active: true },
    });
    await prisma.auditLog.create({ data: { actor: session.email, action: "user.update", target: user.email, detail: { role: body.role, active: body.active, passwordChanged: Boolean(body.password) } } });
    return NextResponse.json({ user });
  } catch (err) {
    return apiError(err);
  }
}
