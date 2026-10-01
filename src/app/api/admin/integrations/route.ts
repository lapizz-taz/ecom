import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, requireApiSession } from "@/lib/auth";
import { describeIntegrations, integrationEnv, IntegrationValueError, isIntegrationKey, saveIntegrationValues, type IntegrationKey } from "@/lib/integrations";
import { isPublicHttps, webhookUrls } from "@/lib/integrations/connect";
import { servicesOverview } from "@/lib/integrations/health";
import { prisma } from "@/lib/db";
import { orderDestination, sampleOrderPayload } from "@/lib/orders/forward";
import { orderLabel } from "@/lib/orders/reference";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function snapshot(req: Request) {
  const [{ fields, status }, services, forwards] = await Promise.all([
    describeIntegrations(),
    servicesOverview(),
    prisma.orderForward.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { order: { select: { id: true, shopifyOrderName: true, platformOrderId: true, status: true } } },
    }),
  ]);
  const e = await integrationEnv();
  const baseUrl = (e.APP_URL ?? new URL(req.url).origin).replace(/\/$/, "");
  return {
    fields,
    status,
    services,
    webhooks: { ...webhookUrls(baseUrl), baseUrl, public: isPublicHttps(baseUrl) },
    orders: {
      destination: orderDestination(e),
      sample: sampleOrderPayload(baseUrl),
      recent: forwards.map((f) => ({
        id: f.id,
        order: orderLabel(f.order),
        status: f.status,
        attempts: f.attempts,
        responseCode: f.responseCode,
        error: f.error,
        externalId: f.externalId,
        createdAt: f.createdAt.toISOString(),
        sentAt: f.sentAt?.toISOString() ?? null,
      })),
    },
  };
}

/** Admin only: which integration credentials are set and where from. Secrets come back masked. */
export async function GET(req: Request) {
  try {
    await requireApiSession(req, { role: "ADMIN" });
    return NextResponse.json(await snapshot(req));
  } catch (err) {
    return apiError(err);
  }
}

const bodySchema = z.object({ values: z.record(z.string(), z.string().max(4096).nullable()) });

/** Admin only: save (string) or remove (null / "") dashboard values. */
export async function PUT(req: Request) {
  try {
    const session = await requireApiSession(req, { role: "ADMIN" });
    const { values } = bodySchema.parse(await req.json());
    const unknown = Object.keys(values).filter((k) => !isIntegrationKey(k));
    if (unknown.length) return NextResponse.json({ error: `Unknown setting: ${unknown.join(", ")}` }, { status: 400 });
    await saveIntegrationValues(values as Partial<Record<IntegrationKey, string | null>>, session.email);
    return NextResponse.json(await snapshot(req));
  } catch (err) {
    if (err instanceof IntegrationValueError) return NextResponse.json({ error: err.message }, { status: 400 });
    return apiError(err);
  }
}
