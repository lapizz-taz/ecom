import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, requireApiSession } from "@/lib/auth";
import { handleInbound } from "@/lib/conversation/service";
import { normalizeBdPhone } from "@/lib/utils/phone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Internal test chat (staff only). Runs the exact production pipeline on the TEST channel
 * (nothing is sent to Meta/WhatsApp) and returns the full trace: guards, tool calls,
 * Shopify data, validation, handoff state.
 */
const bodySchema = z.object({
  sessionId: z.string().regex(/^[a-zA-Z0-9-]{8,64}$/),
  message: z.string().trim().min(1).max(2000),
  shopifyMode: z.enum(["live", "mock:normal", "mock:unavailable", "mock:out_of_stock", "mock:order_fails"]).default("mock:normal"),
  simulatedPhone: z.string().max(20).optional(),
});

export async function POST(req: Request) {
  try {
    const session = await requireApiSession(req, { limitKey: "testChatPerMinute" });
    const body = bodySchema.parse(await req.json());
    const externalUserId = `test:${session.sub}:${body.sessionId}`;
    const { received, result } = await handleInbound(
      {
        channel: "TEST",
        externalUserId,
        externalMessageId: `test-${body.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: body.message,
        profileName: "Test customer",
        verifiedPhone: body.simulatedPhone ? normalizeBdPhone(body.simulatedPhone) : null,
      },
      { shopifyMode: body.shopifyMode, debounceMs: 0 }
    );
    const conv = received.conversationId
      ? await prisma.conversation.findUnique({ where: { id: received.conversationId }, select: { id: true, status: true } })
      : null;
    const stored = received.messageId ? await prisma.message.findUnique({ where: { id: received.messageId }, select: { message: true, metadata: true } }) : null;
    const agent = result?.agent;
    return NextResponse.json({
      conversationId: conv?.id,
      conversationStatus: conv?.status,
      storedCustomerMessage: stored?.message,
      customerMessageMeta: stored?.metadata,
      skipped: result?.status === "skipped" ? result.skipReason : null,
      reply: result?.reply ?? null,
      lang: agent?.lang,
      guard: agent?.guard ?? null,
      signals: agent?.signals,
      toolCalls: agent?.toolTraces ?? [],
      validation: agent?.validation,
      handoff: agent?.handoff ?? null,
      modelReply: agent?.modelReply ?? null,
      llmError: agent?.llmError ?? null,
    });
  } catch (err) {
    return apiError(err);
  }
}

/** Reset a test session (resolves its conversation so the next message starts fresh). */
export async function DELETE(req: Request) {
  try {
    const session = await requireApiSession(req, { limitKey: "testChatPerMinute" });
    const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
    const user = await prisma.channelUser.findUnique({
      where: { channel_externalUserId: { channel: "TEST", externalUserId: `test:${session.sub}:${sessionId}` } },
    });
    if (user) await prisma.conversation.updateMany({ where: { channelUserId: user.id, status: { not: "RESOLVED" } }, data: { status: "RESOLVED" } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
