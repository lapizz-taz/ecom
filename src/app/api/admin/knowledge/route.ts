import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, requireApiSession } from "@/lib/auth";
import { clearKnowledgeCache } from "@/lib/knowledge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const category = z.enum(["BRAND", "POLICY", "FAQ", "PROMOTION", "INSTRUCTION"]);
const createSchema = z.object({
  category,
  key: z.string().trim().regex(/^[a-z0-9._-]{3,80}$/, "key: lowercase letters, numbers, . _ -"),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().max(8000),
  active: z.boolean().default(true),
});
const updateSchema = z.object({
  id: z.string().min(5).max(40),
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().max(8000).optional(),
  active: z.boolean().optional(),
  category: category.optional(),
});

export async function GET(req: Request) {
  try {
    await requireApiSession(req);
    return NextResponse.json({ entries: await prisma.knowledgeEntry.findMany({ orderBy: [{ category: "asc" }, { key: "asc" }] }) });
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireApiSession(req, { role: "ADMIN" });
    const body = createSchema.parse(await req.json());
    const entry = await prisma.knowledgeEntry.create({ data: { ...body, updatedBy: session.email } });
    await prisma.auditLog.create({ data: { actor: session.email, action: "knowledge.create", target: entry.key } });
    clearKnowledgeCache();
    return NextResponse.json({ entry });
  } catch (err) {
    return apiError(err);
  }
}

export async function PUT(req: Request) {
  try {
    const session = await requireApiSession(req, { role: "ADMIN" });
    const { id, ...data } = updateSchema.parse(await req.json());
    const entry = await prisma.knowledgeEntry.update({ where: { id }, data: { ...data, updatedBy: session.email } });
    await prisma.auditLog.create({ data: { actor: session.email, action: "knowledge.update", target: entry.key } });
    clearKnowledgeCache();
    return NextResponse.json({ entry });
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await requireApiSession(req, { role: "ADMIN" });
    const id = new URL(req.url).searchParams.get("id") ?? "";
    const entry = await prisma.knowledgeEntry.delete({ where: { id } });
    await prisma.auditLog.create({ data: { actor: session.email, action: "knowledge.delete", target: entry.key } });
    clearKnowledgeCache();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
