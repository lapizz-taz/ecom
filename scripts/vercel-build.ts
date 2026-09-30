/**
 * Hosted build entry point (`npm run vercel-build`, after `prisma generate`).
 *
 * 1. Resolve the database connection:
 *    - explicit DATABASE_URL (+ DIRECT_URL), or
 *    - the Supabase shortcut (SUPABASE_PROJECT_REF + SUPABASE_REGION + SUPABASE_DB_PASSWORD): find the
 *      shared-pooler cluster that knows the project and compose both connection URLs.
 * 2. Apply migrations and the idempotent seed.
 *    - Not configured / unreachable / password rejected -> skip: the site still deploys, and its login
 *      page and /api/health explain exactly what to fix.
 *    - Database reachable but a migration fails -> fail the build, so a broken schema never goes live.
 * 3. `next build`, passing the discovered pooler host + a status code (never credentials) so
 *    next.config.ts can inline them for runtime.
 */
import { execSync } from "node:child_process";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import {
  classifyConnectionError,
  discoverPoolerHost,
  poolerHostCandidates,
  resolveDb,
  supabaseConnectionUrl,
  type ProbeResult,
} from "../src/lib/dbUrl";

const run = (cmd: string) => execSync(cmd, { stdio: "inherit", env: process.env });
const warn = (msg: string) => console.warn(`\n⚠️  ${msg}\n`);

/** Try to log in with a plain Postgres client, returning the server's verdict. */
async function probe(url: string): Promise<ProbeResult> {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10_000 });
  // pg emits 'error' on the client for late socket errors; don't let that crash the build.
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("select 1");
    return "ok";
  } catch (err) {
    return classifyConnectionError(err instanceof Error ? err.message : String(err));
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function prismaReachable(): Promise<boolean> {
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

async function resolveConnection(): Promise<string> {
  const db = resolveDb(process.env, "");
  if (db.source === "explicit") {
    process.env.DIRECT_URL ||= process.env.DATABASE_URL;
    return "explicit";
  }
  if (!db.supabaseMode) {
    warn("DATABASE_URL is not set — skipping database migrations and seed. Add it in Vercel → Settings → Environment Variables, then redeploy.");
    return "skipped";
  }
  if (!db.supabasePasswordSet) {
    warn("SUPABASE_DB_PASSWORD is not set — skipping database migrations and seed. Add it in Vercel → Settings → Environment Variables, then redeploy.");
    return "skipped";
  }

  const ref = process.env.SUPABASE_PROJECT_REF!;
  const password = process.env.SUPABASE_DB_PASSWORD!;
  const override = process.env.SUPABASE_POOLER_HOST;
  const region = process.env.SUPABASE_REGION;
  if (!override && !region) {
    warn("SUPABASE_REGION is not set, so the database address can't be found. Set it (e.g. ap-southeast-1) or SUPABASE_POOLER_HOST, then redeploy.");
    return "not_found";
  }
  const candidates = override ? [override] : poolerHostCandidates(region!);
  const found = await discoverPoolerHost(candidates, (host) => probe(supabaseConnectionUrl({ host, ref, password, mode: "session" })));
  if (found.host) process.env.ISO_DB_POOLER_HOST = found.host;

  switch (found.status) {
    case "ok":
      console.log(`✅ Connected to Supabase through ${found.host}`);
      process.env.DATABASE_URL = supabaseConnectionUrl({ host: found.host!, ref, password, mode: "transaction" });
      process.env.DIRECT_URL = supabaseConnectionUrl({ host: found.host!, ref, password, mode: "session" });
      break;
    case "auth_failed":
      warn("Supabase rejected SUPABASE_DB_PASSWORD. Reset the database password in Supabase, update it in Vercel, then redeploy. Skipping migrations.");
      break;
    case "not_found":
      warn(`No Supabase pooler recognised project ${ref} in ${region ?? override}. Check SUPABASE_PROJECT_REF / SUPABASE_REGION. Skipping migrations.`);
      break;
    case "unreachable":
      warn("Could not reach the Supabase pooler from the build. Skipping migrations; redeploy to retry.");
      break;
  }
  return found.status;
}

async function migrateAndSeed(status: string): Promise<string> {
  if (!(status === "ok" || status === "explicit") || !process.env.DATABASE_URL) return status;
  try {
    run("npx prisma migrate deploy");
  } catch {
    // Explicit URLs haven't been probed yet; Supabase ones were reachable a moment ago.
    const reachable = status === "ok" ? true : await prismaReachable();
    if (reachable) {
      console.error(
        "\n❌ The database is reachable but applying migrations failed (see the error above).\n" +
          "   Stopping the build so a broken schema is not deployed.\n"
      );
      process.exit(1);
    }
    warn("Could not connect to the database — check DATABASE_URL / DIRECT_URL. Skipping migrations and seed.");
    return "unreachable";
  }
  try {
    run("npx tsx prisma/seed.ts");
  } catch {
    // The app works without the seed (built-in defaults + /setup page), so don't block the deploy.
    warn("Seeding failed (see above). The site will still deploy; redeploy to retry.");
  }
  return status;
}

async function main() {
  let status = await resolveConnection();
  status = await migrateAndSeed(status);
  process.env.ISO_DB_SETUP_STATUS = status;
  run("npx next build");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
