import { prisma } from "./db";

/**
 * Configuration diagnostics for login/setup problems.
 * Reports only WHICH setting is wrong — never any values.
 */
export interface SetupStatus {
  database: "ok" | "missing_url" | "unreachable" | "not_migrated";
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
  if (!process.env.DATABASE_URL) return { database: "missing_url", sessionSecret, adminExists: false };
  try {
    const admins = await prisma.adminUser.count({ where: { role: "ADMIN", active: true } });
    return { database: "ok", sessionSecret, adminExists: admins > 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    // Table missing => migrations never ran against this database.
    const notMigrated = /does not exist|P2021/.test(msg) || (err as { code?: string }).code === "P2021";
    return { database: notMigrated ? "not_migrated" : "unreachable", sessionSecret, adminExists: false };
  }
}

/** Human-readable explanation of the first problem, or null when everything is fine. */
export function describeProblem(s: SetupStatus): string | null {
  if (s.database === "missing_url") return "DATABASE_URL is not set in your environment variables (Vercel → Settings → Environment Variables), then redeploy.";
  if (s.database === "unreachable") return "The app cannot connect to the database. Check DATABASE_URL and DIRECT_URL (Supabase connection strings, correct password), then redeploy.";
  if (s.database === "not_migrated") return "The database tables have not been created. Redeploy on Vercel (the build creates them) or run `npx prisma migrate deploy`.";
  if (s.sessionSecret === "missing") return "NEXTAUTH_SECRET is not set. Add a random value of at least 32 characters in Vercel → Settings → Environment Variables, then redeploy.";
  if (s.sessionSecret === "too_short") return "NEXTAUTH_SECRET is too short. It must be at least 32 characters — replace it in Vercel → Settings → Environment Variables, then redeploy.";
  return null;
}
