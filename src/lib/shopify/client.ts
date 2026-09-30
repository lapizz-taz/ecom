import { env } from "../env";
import { logger } from "../logger";
import { ShopifyNotConfiguredError, ShopifyUnavailableError } from "./types";

/**
 * Minimal Shopify Admin GraphQL client.
 * Auth: either a static Admin API access token (SHOPIFY_ACCESS_TOKEN, "shpat_...")
 * or client-credentials (SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET) for Dev Dashboard apps,
 * whose tokens expire (~24h) and are refreshed automatically here.
 */

let tokenCache: { token: string; expiresAt: number } | null = null;

function shopDomain(): string {
  const d = env().SHOPIFY_STORE_DOMAIN;
  if (!d) throw new ShopifyNotConfiguredError();
  return d.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

async function accessToken(): Promise<string> {
  const e = env();
  if (e.SHOPIFY_ACCESS_TOKEN) return e.SHOPIFY_ACCESS_TOKEN;
  if (!e.SHOPIFY_CLIENT_ID || !e.SHOPIFY_CLIENT_SECRET) throw new ShopifyNotConfiguredError();
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const res = await fetch(`https://${shopDomain()}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: e.SHOPIFY_CLIENT_ID,
      client_secret: e.SHOPIFY_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => {
    throw new ShopifyUnavailableError(`token request failed: ${(err as Error).message}`);
  });
  if (!res.ok) throw new ShopifyUnavailableError(`token request failed with HTTP ${res.status}`);
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new ShopifyUnavailableError("token response missing access_token");
  tokenCache = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return tokenCache.token;
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
}

export async function shopifyGraphQL<T>(query: string, variables: Record<string, unknown> = {}, attempt = 0): Promise<T> {
  const url = `https://${shopDomain()}/admin/api/${env().SHOPIFY_API_VERSION}/graphql.json`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await accessToken() },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof ShopifyNotConfiguredError || err instanceof ShopifyUnavailableError) throw err;
    if (attempt < 1) return shopifyGraphQL<T>(query, variables, attempt + 1);
    throw new ShopifyUnavailableError(`network error: ${(err as Error).message}`);
  }

  if (res.status === 401 || res.status === 403) {
    tokenCache = null;
    logger.error("shopify auth failed", { status: res.status });
    throw new ShopifyUnavailableError(`Shopify rejected credentials (HTTP ${res.status})`);
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      return shopifyGraphQL<T>(query, variables, attempt + 1);
    }
    throw new ShopifyUnavailableError(`Shopify HTTP ${res.status}`);
  }
  if (!res.ok) throw new ShopifyUnavailableError(`Shopify HTTP ${res.status}`);

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    const throttled = json.errors.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return shopifyGraphQL<T>(query, variables, attempt + 1);
    }
    logger.error("shopify graphql errors", { errors: json.errors.map((e) => e.message).slice(0, 3) });
    throw new ShopifyUnavailableError(`Shopify GraphQL error: ${json.errors[0]!.message}`);
  }
  if (!json.data) throw new ShopifyUnavailableError("empty Shopify response");
  return json.data;
}
