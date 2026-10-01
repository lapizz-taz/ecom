import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, requireApiSession } from "@/lib/auth";
import { describeIntegrations, integrationEnv, IntegrationValueError, isIntegrationKey, saveIntegrationValues, type IntegrationKey } from "@/lib/integrations";
import { isPublicHttps, webhookUrls } from "@/lib/integrations/connect";
import { servicesOverview } from "@/lib/integrations/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function snapshot(req: Request) {
  const [{ fields, status }, services] = await Promise.all([describeIntegrations(), servicesOverview()]);
  const baseUrl = ((await integrationEnv()).APP_URL ?? new URL(req.url).origin).replace(/\/$/, "");
  return { fields, status, services, webhooks: { ...webhookUrls(baseUrl), baseUrl, public: isPublicHttps(baseUrl) } };
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
