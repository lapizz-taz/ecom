import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, requireApiSession } from "@/lib/auth";
import { generateVerifyToken, integrationEnv, saveIntegrationValues } from "@/lib/integrations";
import { SERVICE_IDS, setupWebhooks, type ServiceId } from "@/lib/integrations/connect";
import { checkAllConfigured, runCheck } from "@/lib/integrations/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 40;

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("test"), service: z.enum(SERVICE_IDS as [string, ...string[]]) }),
  z.object({ action: z.literal("test-all") }),
  z.object({ action: z.literal("webhooks"), service: z.enum(["messenger", "instagram", "whatsapp"]) }),
  z.object({ action: z.literal("generate-token"), token: z.enum(["META_VERIFY_TOKEN", "WHATSAPP_VERIFY_TOKEN"]) }),
]);

/** Admin only: test one or all connections (results are stored), set up Meta webhooks, or generate a verify token. */
export async function POST(req: Request) {
  try {
    const session = await requireApiSession(req, { role: "ADMIN" });
    const body = bodySchema.parse(await req.json());
    if (body.action === "test") return NextResponse.json(await runCheck(body.service as ServiceId, session.email));
    if (body.action === "test-all") return NextResponse.json(await checkAllConfigured(session.email, { timeoutMs: 30_000 }));
    if (body.action === "webhooks") {
      const baseUrl = (await integrationEnv()).APP_URL ?? new URL(req.url).origin;
      return NextResponse.json(await setupWebhooks(body.service, baseUrl, session.email));
    }
    await saveIntegrationValues({ [body.token]: generateVerifyToken() }, session.email);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
