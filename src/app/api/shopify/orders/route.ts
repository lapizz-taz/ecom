import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiError, requireApiSession } from "@/lib/auth";
import { getSettings } from "@/lib/config/settings";
import { getShopify, normalizeOrderNumber, ShopifyNotConfiguredError, ShopifyUnavailableError } from "@/lib/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Staff: AI-generated orders, or a Shopify order lookup with ?number=1001. */
export async function GET(req: Request) {
  try {
    const session = await requireApiSession(req);
    const number = new URL(req.url).searchParams.get("number");
    if (number) {
      const n = normalizeOrderNumber(number);
      if (!n) return NextResponse.json({ error: "Invalid order number" }, { status: 400 });
      const settings = await getSettings();
      const order = await getShopify(settings.business.website, "live").findOrderByName(n);
      await prisma.auditLog.create({ data: { actor: session.email, action: "order.lookup", target: n } });
      return NextResponse.json({ order });
    }
    const orders = await prisma.order.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { customer: { select: { id: true, name: true } } },
    });
    return NextResponse.json({ orders });
  } catch (err) {
    if (err instanceof ShopifyNotConfiguredError) return NextResponse.json({ error: "Shopify is not configured" }, { status: 503 });
    if (err instanceof ShopifyUnavailableError) return NextResponse.json({ error: "Shopify is unavailable" }, { status: 502 });
    return apiError(err);
  }
}
