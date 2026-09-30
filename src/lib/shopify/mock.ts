import seed from "@data/products/seed-products.json";
import { normalizeBdPhone, phonesMatch } from "../utils/phone";
import {
  ShopifyUnavailableError,
  type CreateOrderInput,
  type CreateOrderResult,
  type OrderInfo,
  type ProductInfo,
  type ProductSearchOptions,
  type ShopifyProvider,
} from "./types";

/**
 * In-memory Shopify used by /test-chat ("mock" mode) and automated tests.
 * Built from data/products/seed-products.json. Never used for real customers.
 */
export type MockBehaviour = "normal" | "unavailable" | "out_of_stock" | "order_fails";

interface SeedVariant {
  id: string;
  title: string;
  sku: string;
  price: string;
  compareAtPrice: string | null;
  options: { name: string; value: string }[];
  inventoryQuantity: number;
  tracked: boolean;
  availableForSale: boolean;
}

function buildProducts(website: string, behaviour: MockBehaviour): ProductInfo[] {
  return seed.products.map((p) => {
    const variants = (p.variants as SeedVariant[]).map((v) => {
      const oos = behaviour === "out_of_stock";
      return {
        id: v.id,
        title: v.title,
        sku: v.sku,
        price: Number(v.price),
        compareAtPrice: v.compareAtPrice ? Number(v.compareAtPrice) : null,
        options: v.options,
        available: oos ? false : v.availableForSale,
        inventoryQuantity: v.tracked ? (oos ? 0 : v.inventoryQuantity) : null,
        tracked: v.tracked,
      };
    });
    const optionMap = new Map<string, Set<string>>();
    for (const v of variants) for (const o of v.options) optionMap.set(o.name, (optionMap.get(o.name) ?? new Set()).add(o.value));
    const prices = variants.map((v) => v.price);
    return {
      id: p.id,
      handle: p.handle,
      title: p.title,
      description: p.description,
      productType: p.productType,
      tags: p.tags,
      url: `${website.replace(/\/$/, "")}/products/${p.handle}`,
      image: null,
      currency: "BDT",
      priceMin: Math.min(...prices),
      priceMax: Math.max(...prices),
      available: variants.some((v) => v.available),
      totalInventory: variants.reduce((s, v) => s + (v.inventoryQuantity ?? 0), 0),
      options: [...optionMap.entries()].map(([name, values]) => ({ name, values: [...values] })),
      variants,
      status: p.status,
    };
  });
}

export class MockShopifyProvider implements ShopifyProvider {
  readonly name = "mock" as const;
  static createdOrders: { input: CreateOrderInput; name: string }[] = [];
  constructor(private website: string, private behaviour: MockBehaviour = "normal") {}

  private guard() {
    if (this.behaviour === "unavailable") throw new ShopifyUnavailableError("mock: Shopify unavailable");
  }

  private products() {
    return buildProducts(this.website, this.behaviour);
  }

  async searchProducts(query: string, opts: ProductSearchOptions = {}) {
    this.guard();
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
    return this.products()
      .filter((p) => {
        const hay = `${p.title} ${p.productType} ${p.tags.join(" ")} ${p.description}`.toLowerCase();
        return words.length === 0 || words.some((w) => hay.includes(w.replace(/s$/, "")));
      })
      .filter((p) => opts.maxPrice === undefined || p.priceMin <= opts.maxPrice)
      .slice(0, opts.limit ?? 6);
  }

  async getProduct(idOrHandle: string) {
    this.guard();
    return this.products().find((p) => p.id === idOrHandle || p.handle === idOrHandle) ?? null;
  }

  async getVariant(variantId: string) {
    this.guard();
    for (const product of this.products()) {
      const variant = product.variants.find((v) => v.id === variantId);
      if (variant) return { product, variant };
    }
    return null;
  }

  private orders(): OrderInfo[] {
    return seed.orders.map((o) => ({
      id: o.id,
      name: o.name,
      createdAt: o.createdAt,
      phones: [o.phone],
      financialStatus: o.financialStatus,
      fulfillmentStatus: o.fulfillmentStatus,
      cancelled: o.cancelled,
      total: Number(o.total),
      currency: o.currency,
      items: o.items,
      tracking: o.tracking,
    }));
  }

  async findOrderByName(orderNumber: string) {
    this.guard();
    const clean = orderNumber.replace(/^#/, "");
    return this.orders().find((o) => o.name.replace(/^#/, "") === clean) ?? null;
  }

  async findOrdersByPhone(phone: string, limit = 5) {
    this.guard();
    const n = normalizeBdPhone(phone);
    return this.orders().filter((o) => o.phones.some((p) => phonesMatch(p, n))).slice(0, limit);
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    this.guard();
    if (this.behaviour === "order_fails") return { ok: false, error: "mock: order creation failed" };
    const name = `#MOCK-${1000 + MockShopifyProvider.createdOrders.length + 1}`;
    MockShopifyProvider.createdOrders.push({ input, name });
    const draftId = `gid://shopify/DraftOrder/mock-${Date.now()}`;
    if (input.mode === "draft") return { ok: true, mode: "draft", orderId: null, orderName: null, draftId, draftName: "#D-MOCK" };
    return { ok: true, mode: "complete", orderId: `gid://shopify/Order/mock-${Date.now()}`, orderName: name, draftId, draftName: "#D-MOCK" };
  }

  async listProducts() {
    this.guard();
    return { products: this.products(), nextCursor: null };
  }
}
