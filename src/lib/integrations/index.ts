import crypto from "node:crypto";
import { prisma } from "../db";
import { env, type Env } from "../env";
import { logger, errorInfo } from "../logger";
import { decryptSecret, encryptSecret } from "./crypto";

/**
 * Integration credentials can come from two places:
 *  1. the dashboard's Integrations page (encrypted in the IntegrationSecret table), or
 *  2. environment variables (Vercel → Settings → Environment Variables).
 * A dashboard value wins over the environment variable of the same name, so staff can connect or
 * rotate a key without a redeploy. Every read of these credentials goes through integrationEnv().
 */
export const INTEGRATION_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "SHOPIFY_STORE_DOMAIN",
  "SHOPIFY_ACCESS_TOKEN",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "META_APP_ID",
  "META_APP_SECRET",
  "META_VERIFY_TOKEN",
  "META_ACCESS_TOKEN",
  "META_PAGE_ID",
  "INSTAGRAM_ACCESS_TOKEN",
  "INSTAGRAM_ACCOUNT_ID",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
] as const satisfies readonly (keyof Env)[];

export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

/** Never sent back to the browser — only a masked hint ("••••abcd"). */
export const SECRET_KEYS: ReadonlySet<IntegrationKey> = new Set([
  "OPENAI_API_KEY",
  "SHOPIFY_ACCESS_TOKEN",
  "SHOPIFY_CLIENT_SECRET",
  "META_APP_SECRET",
  "META_ACCESS_TOKEN",
  "INSTAGRAM_ACCESS_TOKEN",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_APP_SECRET",
]);

export function isIntegrationKey(k: string): k is IntegrationKey {
  return (INTEGRATION_KEYS as readonly string[]).includes(k);
}

const TTL_MS = 30_000;
let cache: { at: number; base: Env; merged: Env; dashboard: Partial<Record<IntegrationKey, string>>; unreadable: IntegrationKey[] } | null = null;

export function clearIntegrationCache() {
  cache = null;
}

async function readDashboard(): Promise<{ values: Partial<Record<IntegrationKey, string>>; unreadable: IntegrationKey[] }> {
  const rows = await prisma.integrationSecret.findMany();
  const values: Partial<Record<IntegrationKey, string>> = {};
  const unreadable: IntegrationKey[] = [];
  for (const row of rows) {
    if (!isIntegrationKey(row.key)) continue;
    const plain = decryptSecret(row.value);
    if (plain === null) unreadable.push(row.key);
    else if (plain) values[row.key] = plain;
  }
  return { values, unreadable };
}

async function load(fresh: boolean) {
  const base = env();
  if (!fresh && cache && cache.base === base && Date.now() - cache.at < TTL_MS) return cache;
  try {
    const { values, unreadable } = await readDashboard();
    if (unreadable.length) logger.warn("integration credentials could not be decrypted (NEXTAUTH_SECRET changed?)", { keys: unreadable });
    cache = { at: Date.now(), base, merged: { ...base, ...values }, dashboard: values, unreadable };
    return cache;
  } catch (err) {
    // Database unreachable: keep serving the last known values, or the environment alone.
    logger.warn("integration credentials unavailable, using environment only", errorInfo(err));
    if (cache && cache.base === base) return cache;
    return { at: 0, base, merged: base, dashboard: {}, unreadable: [] };
  }
}

/** Environment variables with dashboard-entered integration credentials applied on top. */
export async function integrationEnv(opts: { fresh?: boolean } = {}): Promise<Env> {
  return (await load(Boolean(opts.fresh))).merged;
}

export type IntegrationStatus = Record<"openai" | "shopify" | "meta" | "instagram" | "whatsapp" | "notifications", boolean>;

export function statusOf(e: Env): IntegrationStatus {
  return {
    openai: Boolean(e.OPENAI_API_KEY),
    shopify: Boolean(e.SHOPIFY_STORE_DOMAIN && (e.SHOPIFY_ACCESS_TOKEN || (e.SHOPIFY_CLIENT_ID && e.SHOPIFY_CLIENT_SECRET))),
    meta: Boolean(e.META_APP_SECRET && e.META_VERIFY_TOKEN && e.META_ACCESS_TOKEN),
    instagram: Boolean(e.META_APP_SECRET && e.META_VERIFY_TOKEN && (e.INSTAGRAM_ACCESS_TOKEN || e.META_ACCESS_TOKEN)),
    whatsapp: Boolean(e.WHATSAPP_PHONE_NUMBER_ID && e.WHATSAPP_ACCESS_TOKEN && e.WHATSAPP_VERIFY_TOKEN && (e.WHATSAPP_APP_SECRET || e.META_APP_SECRET)),
    notifications: Boolean(e.HANDOFF_WEBHOOK_URL || e.RESEND_API_KEY),
  };
}

export async function integrationStatus(): Promise<IntegrationStatus> {
  return statusOf(await integrationEnv());
}

// ---------- dashboard editing ----------

export interface FieldState {
  /** Where the value in effect comes from. */
  source: "dashboard" | "env" | "none";
  /** Full value — only for non-secret fields. */
  value: string | null;
  /** Last 4 characters of a secret, for recognition. */
  hint: string | null;
  /** A dashboard value exists but can't be decrypted (NEXTAUTH_SECRET changed) — re-enter it. */
  unreadable: boolean;
}

export async function describeIntegrations(): Promise<{ fields: Record<IntegrationKey, FieldState>; status: IntegrationStatus }> {
  const state = await load(true);
  const fields = {} as Record<IntegrationKey, FieldState>;
  for (const k of INTEGRATION_KEYS) {
    const fromDashboard = state.dashboard[k];
    // Only count variables actually set in the environment, not schema defaults (e.g. OPENAI_MODEL).
    const fromEnv = process.env[k] ? (state.base[k] as string | undefined) : undefined;
    const v = fromDashboard ?? fromEnv;
    const secret = SECRET_KEYS.has(k);
    fields[k] = {
      source: fromDashboard !== undefined ? "dashboard" : fromEnv ? "env" : "none",
      value: v && !secret ? String(v) : null,
      hint: v && secret ? String(v).slice(-4) : null,
      unreadable: state.unreadable.includes(k),
    };
  }
  return { fields, status: statusOf(state.merged) };
}

export class IntegrationValueError extends Error {}

const NUMERIC_ID: IntegrationKey[] = ["META_APP_ID", "META_PAGE_ID", "INSTAGRAM_ACCOUNT_ID", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID"];

/** Trims and checks a value typed into the dashboard; throws IntegrationValueError with a human message. */
export function normalizeValue(key: IntegrationKey, raw: string): string {
  let v = raw.trim();
  if (v.length > 4096) throw new IntegrationValueError(`${key} is too long`);
  if (/\s/.test(v)) throw new IntegrationValueError(`${key} must not contain spaces or line breaks`);
  if (key === "SHOPIFY_STORE_DOMAIN") {
    v = v.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(v)) {
      throw new IntegrationValueError("Use your store's xxx.myshopify.com address (Shopify admin → Settings → Domains), not your own domain");
    }
  }
  if (NUMERIC_ID.includes(key) && !/^\d+$/.test(v)) throw new IntegrationValueError(`${key} should only contain numbers`);
  if (key === "OPENAI_MODEL" && !/^[\w.:-]+$/.test(v)) throw new IntegrationValueError("That doesn't look like a model name (e.g. gpt-4.1-mini)");
  return v;
}

/**
 * Save or clear dashboard values. A `null` (or empty string) removes the dashboard value, so the
 * environment variable — if any — applies again.
 */
export async function saveIntegrationValues(patch: Partial<Record<IntegrationKey, string | null>>, actor: string): Promise<IntegrationKey[]> {
  const ops = [];
  const changed: IntegrationKey[] = [];
  for (const [k, raw] of Object.entries(patch)) {
    if (!isIntegrationKey(k) || raw === undefined) continue;
    changed.push(k);
    if (raw === null || raw.trim() === "") {
      ops.push(prisma.integrationSecret.deleteMany({ where: { key: k } }));
    } else {
      const value = encryptSecret(normalizeValue(k, raw));
      ops.push(prisma.integrationSecret.upsert({ where: { key: k }, create: { key: k, value, updatedBy: actor }, update: { value, updatedBy: actor } }));
    }
  }
  if (!changed.length) return changed;
  await prisma.$transaction(ops);
  // Key names only — never values.
  await prisma.auditLog.create({ data: { actor, action: "integrations.update", target: changed.join(",").slice(0, 500) } });
  clearIntegrationCache();
  return changed;
}

/** A random webhook verify token (letters and digits, easy to copy). */
export function generateVerifyToken(): string {
  return `iso_${crypto.randomBytes(18).toString("base64url").replace(/[-_]/g, "x")}`;
}
