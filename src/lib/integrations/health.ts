import type { Channel } from "@prisma/client";
import { prisma } from "../db";
import type { Env } from "../env";
import { getSettings } from "../config/settings";
import { sendStaffAlert } from "../handoff/notify";
import { logger, errorInfo } from "../logger";
import { integrationEnv, SERVICE_KEYS, statusOf } from "./index";
import { SERVICE_IDS, testConnection, type CheckResult, type ServiceId } from "./connect";

/**
 * Connection health: the latest check per service is stored, shown on the Integrations page and in
 * the sidebar, and refreshed by the daily maintenance run — which alerts staff when one breaks.
 */

export const SERVICE_NAMES: Record<ServiceId, string> = {
  openai: "OpenAI",
  shopify: "Shopify",
  meta: "Meta app",
  messenger: "Facebook Messenger",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
};

/** Whether a service has everything it needs to run (the same rule the bot itself uses). */
export function configuredServices(e: Env): Record<ServiceId, boolean> {
  const s = statusOf(e);
  return {
    openai: s.openai,
    shopify: s.shopify,
    meta: Boolean(e.META_APP_ID && e.META_APP_SECRET),
    messenger: s.meta,
    instagram: s.instagram,
    whatsapp: s.whatsapp,
  };
}

export interface StoredCheck extends CheckResult {
  checkedAt: string;
  checkedBy: string | null;
}

async function saveCheck(service: ServiceId, r: CheckResult, actor: string) {
  const data = { ok: r.ok, message: r.message.slice(0, 1000), notes: r.notes ?? [], checkedAt: new Date(), checkedBy: actor };
  await prisma.integrationCheck.upsert({ where: { service }, create: { service, ...data }, update: data });
}

/** Test one connection and remember the result. */
export async function runCheck(service: ServiceId, actor: string): Promise<CheckResult> {
  const r = await testConnection(service, actor);
  await saveCheck(service, r, actor);
  return r;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Test every configured connection in parallel. A check that doesn't answer in time is skipped
 * (not recorded as a failure). With `alert`, staff are notified about connections that just broke.
 */
export async function checkAllConfigured(actor: string, opts: { timeoutMs?: number; alert?: boolean } = {}) {
  const e = await integrationEnv({ fresh: true });
  const configured = configuredServices(e);
  const services = SERVICE_IDS.filter((s) => configured[s]);
  const previous = new Map((await prisma.integrationCheck.findMany()).map((c) => [c.service, c.ok]));

  const results = await Promise.all(
    services.map(async (s) => ({ s, r: await withTimeout(testConnection(s, actor).catch((err): CheckResult => ({ ok: false, message: (err as Error).message })), opts.timeoutMs ?? 25_000) }))
  );
  const report = { checked: [] as ServiceId[], failed: [] as ServiceId[], skipped: [] as ServiceId[] };
  const newlyBroken: { s: ServiceId; message: string }[] = [];
  for (const { s, r } of results) {
    if (!r) {
      report.skipped.push(s);
      continue;
    }
    await saveCheck(s, r, actor);
    report.checked.push(s);
    if (!r.ok) {
      report.failed.push(s);
      if (previous.get(s) !== false) newlyBroken.push({ s, message: r.message });
    }
  }

  if (opts.alert && newlyBroken.length) {
    const base = e.APP_URL?.replace(/\/$/, "") ?? "";
    const text =
      `⚠️ Isolation: ${newlyBroken.length === 1 ? "a connection stopped working" : `${newlyBroken.length} connections stopped working`}\n` +
      newlyBroken.map((b) => `• ${SERVICE_NAMES[b.s]}: ${b.message}`).join("\n") +
      `\n${base}/admin/integrations`;
    await sendStaffAlert({ settings: await getSettings(), subject: "Isolation: an integration needs attention", text }).catch((err) =>
      logger.warn("integration alert failed", errorInfo(err))
    );
  }
  return report;
}

export type Health = "ok" | "problem" | "off";

/** Sidebar status: off (not set up), problem (last check failed) or ok. */
export async function integrationHealth(): Promise<Record<"openai" | "shopify" | "meta" | "instagram" | "whatsapp" | "notifications", Health>> {
  const e = await integrationEnv();
  const configured = configuredServices(e);
  const failing = new Set((await prisma.integrationCheck.findMany({ where: { ok: false }, select: { service: true } })).map((c) => c.service));
  const h = (s: ServiceId): Health => (failing.has(s) ? "problem" : !configured[s] ? "off" : "ok");
  return {
    openai: h("openai"),
    shopify: h("shopify"),
    meta: h("messenger"),
    instagram: h("instagram"),
    whatsapp: h("whatsapp"),
    notifications: statusOf(e).notifications ? "ok" : "off",
  };
}

export interface ServiceOverview {
  configured: boolean;
  check: StoredCheck | null;
  /** Channels only: when the last customer message arrived — proof the webhook works end to end. */
  lastInbound: string | null;
  /** Latest dashboard change to this service's keys. */
  lastChange: { at: string; by: string | null } | null;
}

const CHANNEL_OF: Partial<Record<ServiceId, Channel>> = { messenger: "MESSENGER", instagram: "INSTAGRAM", whatsapp: "WHATSAPP" };

export async function servicesOverview(): Promise<Record<ServiceId, ServiceOverview>> {
  const e = await integrationEnv();
  const configured = configuredServices(e);
  const [checks, rows, inbound] = await Promise.all([
    prisma.integrationCheck.findMany(),
    prisma.integrationSecret.findMany({ select: { key: true, updatedAt: true, updatedBy: true } }),
    Promise.all(
      Object.entries(CHANNEL_OF).map(async ([service, channel]) => {
        const c = await prisma.conversation.findFirst({
          where: { channel, lastCustomerMessageAt: { not: null } },
          orderBy: { lastCustomerMessageAt: "desc" },
          select: { lastCustomerMessageAt: true },
        });
        return [service, c?.lastCustomerMessageAt?.toISOString() ?? null] as const;
      })
    ),
  ]);
  const checkOf = new Map(checks.map((c) => [c.service, c]));
  const inboundOf = new Map<string, string | null>(inbound);
  const out = {} as Record<ServiceId, ServiceOverview>;
  for (const s of SERVICE_IDS) {
    const c = checkOf.get(s);
    const latest = rows.filter((r) => (SERVICE_KEYS[s] as string[]).includes(r.key)).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    out[s] = {
      configured: configured[s],
      check: c ? { ok: c.ok, message: c.message, notes: (c.notes as string[] | null) ?? undefined, checkedAt: c.checkedAt.toISOString(), checkedBy: c.checkedBy } : null,
      lastInbound: inboundOf.get(s) ?? null,
      lastChange: latest ? { at: latest.updatedAt.toISOString(), by: latest.updatedBy } : null,
    };
  }
  return out;
}
