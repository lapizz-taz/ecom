import { NextResponse } from "next/server";
import { apiError, requireApiSession } from "@/lib/auth";
import { getSettings } from "@/lib/config/settings";
import { getShopify, ShopifyNotConfiguredError, ShopifyUnavailableError } from "@/lib/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Staff: live Shopify products & stock (search with ?q=, paginate with ?after=). */
export async function GET(req: Request) {
  try {
    await requireApiSession(req);
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.slice(0, 100);
    const after = url.searchParams.get("after");
    const settings = await getSettings();
    const shopify = getShopify(settings.business.website, "live");
    if (q) return NextResponse.json({ products: await shopify.searchProducts(q, { limit: 10 }), nextCursor: null });
    return NextResponse.json(await shopify.listProducts(25, after));
  } catch (err) {
    if (err instanceof ShopifyNotConfiguredError) return NextResponse.json({ error: "Shopify is not configured" }, { status: 503 });
    if (err instanceof ShopifyUnavailableError) return NextResponse.json({ error: "Shopify is unavailable" }, { status: 502 });
    return apiError(err);
  }
}
