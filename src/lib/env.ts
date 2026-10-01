import { z } from "zod";

/**
 * Centralised, validated access to environment variables.
 * Secrets are never hard-coded. Integration credentials (OpenAI, Shopify, Meta, WhatsApp) may also be
 * entered on the dashboard's Integrations page — read those through integrationEnv() in
 * src/lib/integrations, which applies the dashboard values on top of this.
 * Optional integrations return `undefined` so the app can run (e.g. /test-chat in mock mode)
 * before every credential is configured.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().optional(),

  // Optional: the database may instead be configured via the Supabase shortcut (see src/lib/dbUrl.ts).
  DATABASE_URL: z.string().min(1).optional(),

  NEXTAUTH_SECRET: z.string().min(32, "NEXTAUTH_SECRET must be at least 32 characters"),
  ADMIN_EMAIL: z.string().email().optional(),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

  SHOPIFY_STORE_DOMAIN: z.string().optional(),
  SHOPIFY_ACCESS_TOKEN: z.string().optional(),
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().default("2025-07"),
  SHOPIFY_LOCATION_ID: z.string().optional(),

  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  META_PAGE_ID: z.string().optional(),
  INSTAGRAM_ACCESS_TOKEN: z.string().optional(),
  INSTAGRAM_ACCOUNT_ID: z.string().optional(),
  /** "Instagram API with Instagram Login": Instagram webhooks are signed with this, not META_APP_SECRET. */
  INSTAGRAM_APP_SECRET: z.string().optional(),
  META_GRAPH_VERSION: z.string().default("v23.0"),

  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  /** Only used by the dashboard's automatic webhook setup. */
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),

  CRON_SECRET: z.string().optional(),
  HANDOFF_WEBHOOK_URL: z.string().url().optional(),
  RESEND_API_KEY: z.string().optional(),
  NOTIFY_FROM_EMAIL: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(schema.shape)) {
    const v = process.env[key];
    raw[key] = v === "" ? undefined : v;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Never print values — only which variables are invalid.
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  cached = parsed.data;
  return cached;
}

/** For tests only. */
export function resetEnvCache() {
  cached = null;
}
