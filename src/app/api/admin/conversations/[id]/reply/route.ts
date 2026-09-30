import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, requireApiSession } from "@/lib/auth";
import { getAdapter } from "@/lib/channels";
import { track } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ text: z.string().trim().min(1).max(2000) });

/** Staff reply from the dashboard. Sending a reply automatically takes the conversation over. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireApiSession(req);
    const { id } = await params;
    const { text } = schema.parse(await req.json());
    const conv = await prisma.conversation.findUnique({ where: { id }, include: { channelUser: true } });
    if (!conv) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const result = await getAdapter(conv.channel).send(conv.channelUser.externalUserId, text, {
      humanAgent: true,
      lastCustomerMessageAt: conv.lastCustomerMessageAt,
    });
    const message = await prisma.message.create({
      data: {
        conversationId: conv.id,
        sender: "HUMAN",
        message: text,
        sentBy: session.email,
        externalId: result.externalIds[0] ?? null,
        deliveryStatus: result.ok ? "SENT" : "FAILED",
        deliveryError: result.ok ? null : result.error?.slice(0, 500),
        attempts: 1,
      },
    });
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        status: conv.status === "RESOLVED" ? "RESOLVED" : "HUMAN_ACTIVE",
        assignedTo: conv.assignedTo ?? session.email,
        lastMessageAt: new Date(),
        lastMessagePreview: text.slice(0, 140),
      },
    });
    await track("human_message", { channel: conv.channel, conversationId: conv.id, data: { source: "dashboard" } });
    if (!result.ok) return NextResponse.json({ ok: false, error: `Delivery failed: ${result.error}`, messageId: message.id }, { status: 502 });
    return NextResponse.json({ ok: true, messageId: message.id });
  } catch (err) {
    return apiError(err);
  }
}
