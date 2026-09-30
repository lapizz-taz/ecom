import { shopifyGraphQL } from "./client";
import { logger } from "../logger";
import { normalizeBdPhone, phonesMatch } from "../utils/phone";
import type {
  CreateOrderInput,
  CreateOrderResult,
  OrderInfo,
  ProductInfo,
  ProductSearchOptions,
  ShopifyProvider,
  VariantInfo,
} from "./types";

const PRODUCT_FIELDS = /* GraphQL */ `
  fragment ProductFields on Product {
    id
    handle
    title
    description
    productType
    tags
    status
    onlineStoreUrl
    totalInventory
    featuredMedia { preview { image { url } } }
    options { name optionValues { name } }
    priceRangeV2 {
      minVariantPrice { amount currencyCode }
      maxVariantPrice { amount currencyCode }
    }
    variants(first: 50) {
      nodes {
        id
        title
        sku
        price
        compareAtPrice
        availableForSale
        inventoryQuantity
        inventoryPolicy
        selectedOptions { name value }
        inventoryItem { tracked }
      }
    }
  }
`;

const ORDER_FIELDS = /* GraphQL */ `
  fragment OrderFields on Order {
    id
    name
    createdAt
    phone
    displayFinancialStatus
    displayFulfillmentStatus
    cancelledAt
    totalPriceSet { shopMoney { amount currencyCode } }
    shippingAddress { phone }
    billingAddress { phone }
    customer { phone }
    lineItems(first: 20) { nodes { title variantTitle quantity } }
    fulfillments(first: 5) { trackingInfo(first: 3) { company number url } }
  }
`;

interface RawVariant {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  availableForSale: boolean;
  inventoryQuantity: number | null;
  inventoryPolicy: "DENY" | "CONTINUE";
  selectedOptions: { name: string; value: string }[];
  inventoryItem: { tracked: boolean } | null;
}

interface RawProduct {
  id: string;
  handle: string;
  title: string;
  description: string;
  productType: string | null;
  tags: string[];
  status: string;
  onlineStoreUrl: string | null;
  totalInventory: number | null;
  featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  options: { name: string; optionValues: { name: string }[] }[];
  priceRangeV2: { minVariantPrice: { amount: string; currencyCode: string }; maxVariantPrice: { amount: string; currencyCode: string } };
  variants: { nodes: RawVariant[] };
}

interface RawOrder {
  id: string;
  name: string;
  createdAt: string;
  phone: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  cancelledAt: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  shippingAddress: { phone: string | null } | null;
  billingAddress: { phone: string | null } | null;
  customer: { phone: string | null } | null;
  lineItems: { nodes: { title: string; variantTitle: string | null; quantity: number }[] };
  fulfillments: { trackingInfo: { company: string | null; number: string | null; url: string | null }[] }[];
}

export function mapProduct(p: RawProduct, website: string): ProductInfo {
  const variants: VariantInfo[] = p.variants.nodes.map((v) => {
    const tracked = Boolean(v.inventoryItem?.tracked);
    return {
      id: v.id,
      title: v.title,
      sku: v.sku,
      price: Number(v.price),
      compareAtPrice: v.compareAtPrice ? Number(v.compareAtPrice) : null,
      options: v.selectedOptions.filter((o) => !(o.name === "Title" && o.value === "Default Title")),
      available: v.availableForSale,
      inventoryQuantity: tracked ? v.inventoryQuantity : null,
      tracked,
    };
  });
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    description: (p.description || "").slice(0, 800),
    productType: p.productType || null,
    tags: p.tags,
    url: p.onlineStoreUrl || `${website.replace(/\/$/, "")}/products/${p.handle}`,
    image: p.featuredMedia?.preview?.image?.url ?? null,
    currency: p.priceRangeV2.minVariantPrice.currencyCode,
    priceMin: Number(p.priceRangeV2.minVariantPrice.amount),
    priceMax: Number(p.priceRangeV2.maxVariantPrice.amount),
    available: variants.some((v) => v.available),
    totalInventory: p.totalInventory,
    options: p.options
      .filter((o) => !(o.name === "Title" && o.optionValues.length === 1 && o.optionValues[0]?.name === "Default Title"))
      .map((o) => ({ name: o.name, values: o.optionValues.map((x) => x.name) })),
    variants,
    status: p.status,
  };
}

function mapOrder(o: RawOrder): OrderInfo {
  const phones = [o.phone, o.shippingAddress?.phone, o.billingAddress?.phone, o.customer?.phone].filter(
    (x): x is string => Boolean(x)
  );
  return {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    phones,
    financialStatus: o.displayFinancialStatus,
    fulfillmentStatus: o.displayFulfillmentStatus,
    cancelled: Boolean(o.cancelledAt),
    total: Number(o.totalPriceSet.shopMoney.amount),
    currency: o.totalPriceSet.shopMoney.currencyCode,
    items: o.lineItems.nodes.map((l) => ({ title: l.title, variant: l.variantTitle, quantity: l.quantity })),
    tracking: o.fulfillments.flatMap((f) => f.trackingInfo),
  };
}

/** Escape a user term for Shopify search syntax. */
function escapeTerm(t: string): string {
  return t.replace(/[\\:"'()]/g, " ").trim();
}

export class LiveShopifyProvider implements ShopifyProvider {
  readonly name = "live" as const;
  constructor(private website: string) {}

  async searchProducts(query: string, opts: ProductSearchOptions = {}): Promise<ProductInfo[]> {
    const limit = Math.min(opts.limit ?? 6, 10);
    const words = escapeTerm(query).split(/\s+/).filter(Boolean).slice(0, 6);
    const parts = ["status:active"];
    if (words.length) parts.push(`(${words.map((w) => `${w}*`).join(" OR ")})`);
    if (opts.productType) parts.push(`product_type:"${escapeTerm(opts.productType)}"`);
    const data = await shopifyGraphQL<{ products: { nodes: RawProduct[] } }>(
      `${PRODUCT_FIELDS}
       query Search($q: String!, $first: Int!) {
         products(first: $first, query: $q, sortKey: RELEVANCE) { nodes { ...ProductFields } }
       }`,
      { q: parts.join(" AND "), first: limit * 2 }
    );
    let products = data.products.nodes.map((p) => mapProduct(p, this.website));
    if (opts.maxPrice !== undefined) products = products.filter((p) => p.priceMin <= opts.maxPrice!);
    return products.slice(0, limit);
  }

  async getProduct(idOrHandle: string): Promise<ProductInfo | null> {
    if (idOrHandle.startsWith("gid://shopify/Product/")) {
      const data = await shopifyGraphQL<{ product: RawProduct | null }>(
        `${PRODUCT_FIELDS} query P($id: ID!) { product(id: $id) { ...ProductFields } }`,
        { id: idOrHandle }
      );
      return data.product ? mapProduct(data.product, this.website) : null;
    }
    const data = await shopifyGraphQL<{ productByIdentifier: RawProduct | null }>(
      `${PRODUCT_FIELDS} query P($handle: String!) { productByIdentifier(identifier: { handle: $handle }) { ...ProductFields } }`,
      { handle: idOrHandle }
    );
    return data.productByIdentifier ? mapProduct(data.productByIdentifier, this.website) : null;
  }

  async getVariant(variantId: string) {
    const data = await shopifyGraphQL<{ productVariant: { id: string; product: RawProduct } | null }>(
      `${PRODUCT_FIELDS} query V($id: ID!) { productVariant(id: $id) { id product { ...ProductFields } } }`,
      { id: variantId }
    );
    if (!data.productVariant) return null;
    const product = mapProduct(data.productVariant.product, this.website);
    const variant = product.variants.find((v) => v.id === variantId);
    return variant ? { product, variant } : null;
  }

  async findOrderByName(orderNumber: string): Promise<OrderInfo | null> {
    const clean = orderNumber.replace(/^#/, "");
    const data = await shopifyGraphQL<{ orders: { nodes: RawOrder[] } }>(
      `${ORDER_FIELDS} query O($q: String!) { orders(first: 3, query: $q) { nodes { ...OrderFields } } }`,
      { q: `name:${escapeTerm(clean)}` }
    );
    const match = data.orders.nodes.find((o) => o.name.replace(/^#/, "").toUpperCase() === clean.toUpperCase());
    return match ? mapOrder(match) : null;
  }

  async findOrdersByPhone(phone: string, limit = 5): Promise<OrderInfo[]> {
    const normalized = normalizeBdPhone(phone);
    if (!normalized) return [];
    const intl = `+88${normalized}`;
    const found = new Map<string, OrderInfo>();

    // 1) Customers with that phone -> their orders.
    const customers = await shopifyGraphQL<{ customers: { nodes: { id: string }[] } }>(
      `query C($q: String!) { customers(first: 3, query: $q) { nodes { id } } }`,
      { q: `phone:${intl}` }
    );
    for (const c of customers.customers.nodes) {
      const numericId = c.id.split("/").pop();
      const data = await shopifyGraphQL<{ orders: { nodes: RawOrder[] } }>(
        `${ORDER_FIELDS} query O($q: String!, $first: Int!) { orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ...OrderFields } } }`,
        { q: `customer_id:${numericId}`, first: limit }
      );
      for (const o of data.orders.nodes) found.set(o.id, mapOrder(o));
    }

    // 2) Guest orders: free-text search on the phone number (best effort).
    if (found.size === 0) {
      const data = await shopifyGraphQL<{ orders: { nodes: RawOrder[] } }>(
        `${ORDER_FIELDS} query O($q: String!, $first: Int!) { orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ...OrderFields } } }`,
        { q: normalized, first: limit }
      );
      for (const o of data.orders.nodes) found.set(o.id, mapOrder(o));
    }

    // Always post-filter: only orders whose phone really matches are returned.
    return [...found.values()]
      .filter((o) => o.phones.some((p) => phonesMatch(p, normalized)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const [firstName, ...rest] = input.customer.name.trim().split(/\s+/);
    const phoneIntl = `+88${normalizeBdPhone(input.customer.phone) ?? input.customer.phone}`;
    const draftInput = {
      lineItems: input.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
      phone: phoneIntl,
      shippingAddress: {
        firstName: firstName || input.customer.name,
        lastName: rest.join(" ") || "-",
        address1: input.address.address1,
        city: input.address.city,
        countryCode: "BD",
        phone: phoneIntl,
      },
      shippingLine: {
        title: input.shipping.title,
        priceWithCurrency: { amount: input.shipping.fee.toFixed(2), currencyCode: input.currency },
      },
      note: input.note,
      tags: input.tags,
      customAttributes: [
        { key: "payment_method", value: input.paymentMethod.label },
        { key: "delivery_zone", value: input.address.zoneLabel },
      ],
    };

    const created = await shopifyGraphQL<{
      draftOrderCreate: { draftOrder: { id: string; name: string } | null; userErrors: { field: string[] | null; message: string }[] };
    }>(
      `mutation D($input: DraftOrderInput!) {
         draftOrderCreate(input: $input) { draftOrder { id name } userErrors { field message } }
       }`,
      { input: draftInput }
    );
    const draft = created.draftOrderCreate.draftOrder;
    if (!draft || created.draftOrderCreate.userErrors.length) {
      const msg = created.draftOrderCreate.userErrors.map((e) => e.message).join("; ") || "draft order not created";
      logger.warn("shopify draftOrderCreate failed", { message: msg });
      return { ok: false, error: msg };
    }

    if (input.mode === "draft") {
      return { ok: true, mode: "draft", orderId: null, orderName: null, draftId: draft.id, draftName: draft.name };
    }

    const completed = await shopifyGraphQL<{
      draftOrderComplete: {
        draftOrder: { id: string; order: { id: string; name: string } | null } | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(
      `mutation C($id: ID!) {
         draftOrderComplete(id: $id, paymentPending: true) {
           draftOrder { id order { id name } }
           userErrors { field message }
         }
       }`,
      { id: draft.id }
    );
    const order = completed.draftOrderComplete.draftOrder?.order;
    if (!order || completed.draftOrderComplete.userErrors.length) {
      const msg = completed.draftOrderComplete.userErrors.map((e) => e.message).join("; ") || "draft could not be completed";
      logger.warn("shopify draftOrderComplete failed", { message: msg });
      return { ok: false, error: msg, draftId: draft.id };
    }
    return { ok: true, mode: "complete", orderId: order.id, orderName: order.name, draftId: draft.id, draftName: draft.name };
  }

  async listProducts(first: number, after?: string | null) {
    const data = await shopifyGraphQL<{
      products: { nodes: RawProduct[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    }>(
      `${PRODUCT_FIELDS}
       query L($first: Int!, $after: String) {
         products(first: $first, after: $after, sortKey: TITLE) {
           nodes { ...ProductFields }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { first: Math.min(first, 50), after: after ?? null }
    );
    return {
      products: data.products.nodes.map((p) => mapProduct(p, this.website)),
      nextCursor: data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null,
    };
  }
}
