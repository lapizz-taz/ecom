/**
 * Database connection resolution.
 *
 * Two ways to configure the database:
 *  1. Explicit:  DATABASE_URL (pooled / transaction mode) + DIRECT_URL (session / migrations).
 *  2. Supabase shortcut: SUPABASE_PROJECT_REF + SUPABASE_REGION + SUPABASE_DB_PASSWORD.
 *     The shared-pooler host (`aws-<n>-<region>.pooler.supabase.com`) cannot be derived from the
 *     region, so the build (scripts/vercel-build.ts) discovers it and next.config.ts inlines it
 *     into the server bundle as ISO_DB_POOLER_HOST. SUPABASE_POOLER_HOST overrides discovery.
 *
 * Never inline or log the password — only the host is baked into the build.
 */

// Literal `process.env.X` references so Next.js can inline the build-time values.
const BUILD_POOLER_HOST = process.env.ISO_DB_POOLER_HOST || "";
const BUILD_SETUP_STATUS = process.env.ISO_DB_SETUP_STATUS || "";

export type BuildDbStatus = "ok" | "explicit" | "auth_failed" | "not_found" | "unreachable" | "skipped" | "";

export function buildDbStatus(): BuildDbStatus {
  return BUILD_SETUP_STATUS as BuildDbStatus;
}

export function supabaseConnectionUrl(p: {
  host: string;
  ref: string;
  password: string;
  mode: "transaction" | "session";
}): string {
  const user = `postgres.${p.ref}`;
  const pw = encodeURIComponent(p.password);
  return p.mode === "transaction"
    ? `postgresql://${user}:${pw}@${p.host}:6543/postgres?pgbouncer=true&connection_limit=1`
    : `postgresql://${user}:${pw}@${p.host}:5432/postgres`;
}

/** Candidate shared-pooler hosts for a region, in the order Supabase allocates them. */
export function poolerHostCandidates(region: string): string[] {
  return [0, 1, 2, 3].map((n) => `aws-${n}-${region}.pooler.supabase.com`);
}

export interface ResolvedDb {
  databaseUrl: string | null;
  directUrl: string | null;
  source: "explicit" | "supabase" | "none";
  /** SUPABASE_PROJECT_REF is set, i.e. the Supabase shortcut is in use. */
  supabaseMode: boolean;
  supabasePasswordSet: boolean;
  poolerHost: string | null;
}

export function resolveDb(env: Record<string, string | undefined> = process.env, buildHost = BUILD_POOLER_HOST): ResolvedDb {
  const supabaseMode = Boolean(env.SUPABASE_PROJECT_REF);
  const supabasePasswordSet = Boolean(env.SUPABASE_DB_PASSWORD);
  if (env.DATABASE_URL) {
    return {
      databaseUrl: env.DATABASE_URL,
      directUrl: env.DIRECT_URL || env.DATABASE_URL,
      source: "explicit",
      supabaseMode,
      supabasePasswordSet,
      poolerHost: null,
    };
  }
  const host = env.SUPABASE_POOLER_HOST || env.ISO_DB_POOLER_HOST || buildHost || null;
  if (supabaseMode && supabasePasswordSet && host) {
    const base = { host, ref: env.SUPABASE_PROJECT_REF!, password: env.SUPABASE_DB_PASSWORD! };
    return {
      databaseUrl: supabaseConnectionUrl({ ...base, mode: "transaction" }),
      directUrl: supabaseConnectionUrl({ ...base, mode: "session" }),
      source: "supabase",
      supabaseMode,
      supabasePasswordSet,
      poolerHost: host,
    };
  }
  return { databaseUrl: null, directUrl: null, source: "none", supabaseMode, supabasePasswordSet, poolerHost: host };
}

export type ProbeResult = "ok" | "tenant_not_found" | "auth_failed" | "unreachable" | "error";

/** Classify a Postgres / Supavisor connection error message. */
export function classifyConnectionError(message: string): ProbeResult {
  if (/tenant or user not found/i.test(message)) return "tenant_not_found";
  if (/password authentication failed|authentication failed|invalid password|SASL|circuit breaker/i.test(message)) return "auth_failed";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ETIMEDOUT|timeout|timed out|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(message)) return "unreachable";
  return "error";
}

/**
 * Find the shared-pooler host that knows this project. A wrong cluster answers
 * "Tenant or user not found"; the right one either accepts the login or rejects the password.
 * Stops at the first cluster that recognises the project, so a wrong password costs one attempt.
 */
export async function discoverPoolerHost(
  candidates: string[],
  probe: (host: string) => Promise<ProbeResult>
): Promise<{ host: string | null; status: "ok" | "auth_failed" | "not_found" | "unreachable" }> {
  let sawUnreachable = false;
  for (const host of candidates) {
    const r = await probe(host);
    if (r === "ok") return { host, status: "ok" };
    if (r === "auth_failed") return { host, status: "auth_failed" };
    if (r === "unreachable" || r === "error") sawUnreachable = true;
  }
  return { host: null, status: sawUnreachable ? "unreachable" : "not_found" };
}
