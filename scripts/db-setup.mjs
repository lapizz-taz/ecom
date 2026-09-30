/**
 * Build-time database setup for hosted deploys (runs inside `npm run vercel-build`).
 *
 * - DATABASE_URL / DIRECT_URL not set     -> skip. The site still deploys and its login page and
 *                                            /api/health say exactly which setting is missing.
 * - Database unreachable / login rejected  -> skip. The running site could not use that database
 *                                            either; it explains the problem instead of a 404.
 * - Database reachable, migration fails    -> FAIL the build, so a broken schema never goes live.
 * - Otherwise: apply migrations, then run the idempotent seed (knowledge base, settings, first admin).
 */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const run = (cmd) => execSync(cmd, { stdio: "inherit" });

async function databaseReachable() {
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

if (!process.env.DATABASE_URL || !process.env.DIRECT_URL) {
  console.warn(
    "\n⚠️  DATABASE_URL and/or DIRECT_URL are not set — skipping database migrations and seed.\n" +
      "    Add them in Vercel → Settings → Environment Variables, then redeploy.\n"
  );
  process.exit(0);
}

try {
  run("npx prisma migrate deploy");
} catch {
  if (await databaseReachable()) {
    console.error(
      "\n❌ The database is reachable but applying migrations failed (see the error above).\n" +
        "   Stopping the build so a broken schema is not deployed. If the error mentions a connection,\n" +
        "   check DIRECT_URL (Supabase session pooler, port 5432).\n"
    );
    process.exit(1);
  }
  console.warn(
    "\n⚠️  Could not connect to the database — check DATABASE_URL / DIRECT_URL and the database password.\n" +
      "    Skipping migrations and seed; the site's login page and /api/health will explain what to fix.\n"
  );
  process.exit(0);
}

try {
  run("npx tsx prisma/seed.ts");
} catch {
  // The app works without the seed (built-in defaults + the /setup page), so don't block the deploy.
  console.warn("\n⚠️  Seeding failed (see above). The site will still deploy; re-run the deploy to retry.\n");
}
