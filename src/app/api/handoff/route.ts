import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, requireApiSession } from "@/lib/auth";
import { requestHandoff, resolveConversation, returnToAi, takeOver } from "@/lib/handoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  conversationId: z.string().min(5).max(40),
  action: z.enum(["take_over", "return_to_ai", "resolve", "request"]),
  reason: z.string().trim().max(200).optional(),
});

/** Staff: take over, return to AI, resolve, or manually flag a conversation. */
export async function POST(req: Request) {
  try {
    const session = await requireApiSession(req);
    const body = schema.parse(await req.json());
    const conv = await prisma.conversation.findUnique({ where: { id: body.conversationId }, select: { id: true } });
    if (!conv) return NextResponse.json({ error: "Not found" }, { status: 404 });
    switch (body.action) {
      case "take_over":
        await takeOver(conv.id, session.email);
        break;
      case "return_to_ai":
        await returnToAi(conv.id, session.email);
        break;
      case "resolve":
        await resolveConversation(conv.id, session.email);
        break;
      case "request":
        await requestHandoff(conv.id, "manual", body.reason ?? `Flagged by ${session.email}`);
        break;
    }
    const updated = await prisma.conversation.findUnique({ where: { id: conv.id }, select: { status: true, assignedTo: true } });
    return NextResponse.json({ ok: true, ...updated });
  } catch (err) {
    return apiError(err);
  }
}
