import { prisma } from "./db";
import { buildDbStatus, resolveDb } from "./dbUrl";

/**
 * Configuration diagnostics for login/setup problems.
 * Reports only WHICH setting is wrong — never any values.
 */
export interface SetupStatus {
  database: "ok" | "missing_url" | "missing_password" | "auth_failed" | "pooler_unresolved" | "unreachable" | "not_migrated";
  sessionSecret: "ok" | "missing" | "too_short";
  adminExists: boolean;
}

export function sessionSecretStatus(): SetupStatus["sessionSecret"] {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s) return "missing";
  if (s.length < 32) return "too_short";
  return "ok";
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const sessionSecret = sessionSecretStatus();
  const db = resolveDb();
  const fail = (database: SetupStatus["database"]): SetupStatus => ({ database, sessionSecret, adminExists: false });

  if (db.source === "none") {
    if (!db.supabaseMode) return fail("missing_url");
    if (!db.supabasePasswordSet) return fail("missing_password");
    return fail(buildDbStatus() === "auth_failed" ? "auth_failed" : "pooler_unresolved");
  }
  try {
    const admins = await prisma.adminUser.count({ where: { role: "ADMIN", active: true } });
    return { database: "ok", sessionSecret, adminExists: admins > 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    // Table missing => migrations never ran against this database.
    if (/does not exist|P2021/.test(msg) || (err as { code?: string }).code === "P2021") return fail("not_migrated");
    if (/authentication failed|password authentication/i.test(msg) || buildDbStatus() === "auth_failed") return fail("auth_failed");
    return fail("unreachable");
  }
}

const RESET_PASSWORD_STEPS =
  "In Supabase open your project → Project Settings → Database → Reset database password, copy the new password, " +
  "and save it in Vercel → Settings → Environment Variables as SUPABASE_DB_PASSWORD. Then redeploy.";

/** Human-readable explanations of every current problem (empty when everything is fine). */
export function describeProblems(s: SetupStatus): string[] {
  const out: string[] = [];
  switch (s.database) {
    case "missing_url":
      out.push("DATABASE_URL is not set in your environment variables (Vercel → Settings → Environment Variables), then redeploy.");
      break;
    case "missing_password":
      out.push(`The database password isn't set yet. ${RESET_PASSWORD_STEPS}`);
      break;
    case "auth_failed":
      out.push(`Supabase rejected the database password. ${RESET_PASSWORD_STEPS}`);
      break;
    case "pooler_unresolved":
      out.push(
        "The build couldn't reach your Supabase database. Check SUPABASE_PROJECT_REF and SUPABASE_REGION " +
          "(or set SUPABASE_POOLER_HOST to the host shown in Supabase → Connect), then redeploy."
      );
      break;
    case "unreachable":
      out.push("The app cannot connect to the database. Check SUPABASE_DB_PASSWORD (or DATABASE_URL and DIRECT_URL), then redeploy.");
      break;
    case "not_migrated":
      out.push("The database tables have not been created. Redeploy on Vercel (the build creates them) or run `npx prisma migrate deploy`.");
      break;
  }
  if (s.sessionSecret === "missing") {
    out.push("NEXTAUTH_SECRET is not set. Add a random value of at least 32 characters in Vercel → Settings → Environment Variables, then redeploy.");
  } else if (s.sessionSecret === "too_short") {
    out.push("NEXTAUTH_SECRET is too short. It must be at least 32 characters — replace it in Vercel → Settings → Environment Variables, then redeploy.");
  }
  return out;
}

/** The first problem, or null when everything is fine. */
export function describeProblem(s: SetupStatus): string | null {
  return describeProblems(s)[0] ?? null;
}
