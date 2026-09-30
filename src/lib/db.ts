import { PrismaClient } from "@prisma/client";
import { resolveDb } from "./dbUrl";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// DATABASE_URL, or the URL composed from the Supabase shortcut settings (see dbUrl.ts).
const databaseUrl = resolveDb().databaseUrl;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    ...(databaseUrl ? { datasourceUrl: databaseUrl } : {}),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
