import { logger } from "../logger";

export interface GraphCallResult<T> {
  ok: boolean;
  data?: T;
  status: number;
  error?: string;
  retryable: boolean;
}

const TRANSIENT_META_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

/**
 * POST to a Graph API endpoint with retry + exponential backoff for transient failures.
 * The access token goes in the Authorization header (never the URL) so it can't leak into logs.
 */
export async function graphRequest<T>(
  url: string,
  token: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
  maxAttempts = 3
): Promise<GraphCallResult<T>> {
  let last: GraphCallResult<T> = { ok: false, status: 0, retryable: true, error: "not attempted" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: init.method ?? "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } } & T;
      if (res.ok && !json.error) return { ok: true, data: json, status: res.status, retryable: false };
      const code = json.error?.code;
      const retryable = res.status >= 500 || res.status === 429 || (code !== undefined && TRANSIENT_META_CODES.has(code));
      last = { ok: false, status: res.status, error: `${json.error?.message ?? "HTTP " + res.status}${code ? ` (code ${code})` : ""}`, retryable };
      if (!retryable) break;
    } catch (err) {
      last = { ok: false, status: 0, error: (err as Error).message, retryable: true };
    }
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
  }
  logger.warn("graph api call failed", { host: new URL(url).host, path: new URL(url).pathname, status: last.status, error: last.error });
  return last;
}
