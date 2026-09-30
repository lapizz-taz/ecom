import { z } from "zod";
import { prisma } from "../db";
import defaults from "@data/settings/defaults.json";

/**
 * Central business configuration. Values live in the `Setting` table and are editable
 * from the admin dashboard. `data/settings/defaults.json` only provides first-run defaults.
 */

const nullableText = z.string().trim().max(4000).nullable();

export const businessSchema = z.object({
  brandName: z.string().trim().min(1).max(100),
  website: z.string().url(),
  instagram: z.string().max(100).nullable(),
  facebook: z.string().max(200).nullable(),
  whatsapp: z.string().max(50).nullable(),
  currency: z.string().length(3),
  currencySymbol: z.string().min(1).max(5),
  supportContact: nullableText,
  businessHours: nullableText,
  onlineOnly: z.boolean(),
});

export const deliveryZoneSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/).max(40),
  label: z.string().trim().min(1).max(80),
  fee: z.number().min(0).max(100000),
  estimatedTime: z.string().trim().max(200).nullable(),
  areas: z.array(z.string().trim().toLowerCase().min(1).max(80)).max(500),
});

export const deliverySchema = z.object({
  zones: z.array(deliveryZoneSchema).min(1).max(20),
  notes: nullableText,
});

export const paymentMethodSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/).max(40),
  label: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  instructions: nullableText,
});

export const paymentSchema = z.object({
  methods: z.array(paymentMethodSchema).min(1).max(10),
  notes: nullableText,
});

export const handoffSettingsSchema = z.object({
  pauseAiOnHandoff: z.boolean(),
  onAnger: z.boolean(),
  onRefundRequest: z.boolean(),
  onDiscountRequest: z.boolean(),
  onCancelRequest: z.boolean(),
  onPaymentProblem: z.boolean(),
  dissatisfactionThreshold: z.number().int().min(1).max(10),
  notifyWebhookUrl: z.string().url().nullable(),
  notifyEmail: z.string().email().nullable(),
});

export const aiSettingsSchema = z.object({
  enabled: z.boolean(),
  autoReply: z.boolean(),
  tone: z.string().trim().max(1000),
  languageMode: z.enum(["auto", "en", "bn", "banglish"]),
  brandInstructions: z.string().trim().max(4000),
  maxReplyChars: z.number().int().min(150).max(2000),
  historyMessages: z.number().int().min(4).max(50),
  debounceMs: z.number().int().min(0).max(10000),
  allowOrderCreation: z.boolean(),
  orderCreationMode: z.enum(["complete", "draft"]),
  maxQuantityPerItem: z.number().int().min(1).max(100),
  handoff: handoffSettingsSchema,
});

export const settingsSchema = z.object({
  business: businessSchema,
  delivery: deliverySchema,
  payment: paymentSchema,
  ai: aiSettingsSchema,
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsKey = keyof Settings;
export type DeliveryZone = z.infer<typeof deliveryZoneSchema>;
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const SETTINGS_KEYS: SettingsKey[] = ["business", "delivery", "payment", "ai"];

const DEFAULTS: Settings = settingsSchema.parse(defaults);

export function defaultSettings(): Settings {
  return structuredClone(DEFAULTS);
}

let cache: { value: Settings; at: number } | null = null;
const TTL_MS = 10_000;

export async function getSettings(opts: { fresh?: boolean } = {}): Promise<Settings> {
  if (!opts.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const rows = await prisma.setting.findMany({ where: { key: { in: SETTINGS_KEYS } } });
  const merged: Settings = defaultSettings();
  for (const row of rows) {
    const key = row.key as SettingsKey;
    const partSchema = settingsSchema.shape[key];
    // Merge stored value over defaults so newly-added fields get sane defaults.
    const candidate = { ...(merged[key] as object), ...((row.value as object) ?? {}) };
    const parsed = partSchema.safeParse(candidate);
    if (parsed.success) (merged as Record<SettingsKey, unknown>)[key] = parsed.data;
  }
  cache = { value: merged, at: Date.now() };
  return merged;
}

export async function updateSettings<K extends SettingsKey>(key: K, value: Settings[K], actor: string): Promise<Settings[K]> {
  const parsed = settingsSchema.shape[key].parse(value) as Settings[K];
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: parsed as object, updatedBy: actor },
    update: { value: parsed as object, updatedBy: actor },
  });
  await prisma.auditLog.create({ data: { actor, action: "settings.update", target: key } });
  cache = null;
  return parsed;
}

export function clearSettingsCache() {
  cache = null;
}

export function enabledPaymentMethods(s: Settings): PaymentMethod[] {
  return s.payment.methods.filter((m) => m.enabled);
}

/** Resolve a free-text area (e.g. "Mirpur, Dhaka") or a zone id to a configured delivery zone. */
export function resolveDeliveryZone(s: Settings, input: { zone?: string | null; area?: string | null }): DeliveryZone | null {
  const zones = s.delivery.zones;
  if (input.zone) {
    const z = zones.find((x) => x.id === input.zone);
    if (z) return z;
  }
  const area = input.area?.toLowerCase().trim();
  if (area) {
    // Customers write specific -> general ("Savar, Dhaka"), so the EARLIEST configured area mentioned wins;
    // ties go to the longest match.
    let best: { zone: DeliveryZone; pos: number; len: number } | null = null;
    for (const z of zones) {
      for (const a of z.areas) {
        const re = new RegExp(`(^|[^a-z])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`);
        const m = re.exec(area);
        if (!m) continue;
        const pos = m.index + m[1]!.length;
        if (!best || pos < best.pos || (pos === best.pos && a.length > best.len)) best = { zone: z, pos, len: a.length };
      }
    }
    if (best) return best.zone;
  }
  return null;
}
