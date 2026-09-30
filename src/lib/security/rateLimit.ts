import { prisma } from "../db";
import { logger, errorInfo } from "../logger";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  resetAt: Date;
}

/**
 * Fixed-window rate limiter stored in Postgres, so it works across serverless instances
 * (Vercel) without extra infrastructure. One atomic upsert per check.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000);
  const resetAt = new Date(windowStart.getTime() + windowSeconds * 1000);
  try {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO "RateLimit" ("key", "windowStart", "count")
      VALUES (${key}, ${windowStart}, 1)
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "RateLimit"."windowStart" = ${windowStart} THEN "RateLimit"."count" + 1 ELSE 1 END,
        "windowStart" = ${windowStart}
      RETURNING "count"`;
    const count = Number(rows[0]?.count ?? 1);
    return { allowed: count <= limit, count, limit, resetAt };
  } catch (err) {
    // Fail open on limiter storage errors, but log it — availability beats blocking customers.
    logger.error("rate limiter failure", { key: key.split(":")[0], ...errorInfo(err) });
    return { allowed: true, count: 0, limit, resetAt };
  }
}

export const LIMITS = {
  /** customer messages that get AI processing, per channel user */
  customerPerMinute: { limit: 12, window: 60 },
  customerPerHour: { limit: 120, window: 3600 },
  /** AI replies per conversation per hour (loop protection) */
  aiRepliesPerConversationHour: { limit: 60, window: 3600 },
  /** webhook requests per IP per minute (requests are also signature-verified) */
  webhookPerIpMinute: { limit: 600, window: 60 },
  /** login attempts */
  loginPerIp15m: { limit: 10, window: 900 },
  loginPerEmail15m: { limit: 5, window: 900 },
  /** admin / test-chat API */
  adminApiPerMinute: { limit: 120, window: 60 },
  testChatPerMinute: { limit: 30, window: 60 },
} as const;

export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return headers.get("x-real-ip") || "unknown";
}
