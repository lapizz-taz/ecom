import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, requireApiSession } from "@/lib/auth";
import { normalizeBdPhone } from "@/lib/utils/phone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().trim().max(100).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireApiSession(req);
    const { id } = await params;
    const body = schema.parse(await req.json());
    let phone: string | null | undefined = undefined;
    if (body.phone !== undefined) {
      phone = body.phone ? normalizeBdPhone(body.phone) : null;
      if (body.phone && !phone) return NextResponse.json({ error: "Invalid Bangladeshi phone number" }, { status: 400 });
    }
    const customer = await prisma.customer.update({
      where: { id },
      data: { name: body.name, tags: body.tags, notes: body.notes, ...(phone !== undefined ? { phone, phoneVerified: false } : {}) },
    });
    await prisma.auditLog.create({ data: { actor: session.email, action: "customer.update", target: id } });
    return NextResponse.json({ customer: { id: customer.id, name: customer.name, tags: customer.tags } });
  } catch (err) {
    return apiError(err);
  }
}
