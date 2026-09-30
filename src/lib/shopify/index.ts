import { integrationStatus } from "../env";
import { LiveShopifyProvider } from "./live";
import { MockShopifyProvider, type MockBehaviour } from "./mock";
import { ShopifyNotConfiguredError, type ShopifyProvider } from "./types";

export * from "./types";
export { MockShopifyProvider } from "./mock";
export type { MockBehaviour } from "./mock";

export type ShopifyMode = "live" | `mock:${MockBehaviour}`;

/**
 * Production traffic always uses the live Shopify provider.
 * Mock modes are only reachable from the authenticated /test-chat and tests.
 */
export function getShopify(website: string, mode: ShopifyMode = "live"): ShopifyProvider {
  if (mode === "live") {
    if (!integrationStatus().shopify) throw new ShopifyNotConfiguredError();
    return new LiveShopifyProvider(website);
  }
  return new MockShopifyProvider(website, mode.slice(5) as MockBehaviour);
}
