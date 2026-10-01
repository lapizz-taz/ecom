import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, requireApiSession } from "@/lib/auth";
import { deliverForward } from "@/lib/orders/forward";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const bodySchema = z.object({ forwardId: z.string().trim().min(5).max(40) });

/** Staff: resend an order the order platform hasn't accepted yet (also revives one that gave up). */
export async function POST(req: Request) {
  try {
    const session = await requireApiSession(req);
    const { forwardId } = bodySchema.parse(await req.json());
    const fwd = await prisma.orderForward.findUnique({ where: { id: forwardId }, select: { status: true, orderId: true } });
    if (!fwd) return NextResponse.json({ error: "Delivery not found" }, { status: 404 });
    if (fwd.status === "sent") return NextResponse.json({ error: "This order was already delivered" }, { status: 409 });
    await prisma.auditLog.create({ data: { actor: session.email, action: "order.resend", target: fwd.orderId } });
    const r = await deliverForward(forwardId, { force: true });
    return NextResponse.json(r);
  } catch (err) {
    return apiError(err);
  }
}
