export interface VariantInfo {
  id: string;
  title: string;
  sku: string | null;
  price: number;
  compareAtPrice: number | null;
  options: { name: string; value: string }[];
  available: boolean;
  inventoryQuantity: number | null;
  tracked: boolean;
}

export interface ProductInfo {
  id: string;
  handle: string;
  title: string;
  description: string;
  productType: string | null;
  tags: string[];
  url: string;
  image: string | null;
  currency: string;
  priceMin: number;
  priceMax: number;
  available: boolean;
  totalInventory: number | null;
  options: { name: string; values: string[] }[];
  variants: VariantInfo[];
  status: string;
}

export interface OrderInfo {
  id: string;
  name: string;
  createdAt: string;
  /** Phones attached to the order — used ONLY for ownership verification, never returned to the AI. */
  phones: string[];
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  cancelled: boolean;
  total: number;
  currency: string;
  items: { title: string; variant: string | null; quantity: number }[];
  tracking: { company: string | null; number: string | null; url: string | null }[];
}

export interface CreateOrderInput {
  items: { variantId: string; quantity: number; title: string; unitPrice: number }[];
  customer: { name: string; phone: string };
  address: { address1: string; city: string; zoneLabel: string };
  shipping: { title: string; fee: number };
  currency: string;
  paymentMethod: { id: string; label: string };
  note: string;
  tags: string[];
  mode: "complete" | "draft";
}

export type CreateOrderResult =
  | { ok: true; mode: "complete" | "draft"; orderId: string | null; orderName: string | null; draftId: string; draftName: string | null }
  | { ok: false; error: string; draftId?: string | null };

export interface ProductSearchOptions {
  limit?: number;
  maxPrice?: number;
  productType?: string;
}

export interface ShopifyProvider {
  readonly name: "live" | "mock";
  searchProducts(query: string, opts?: ProductSearchOptions): Promise<ProductInfo[]>;
  getProduct(idOrHandle: string): Promise<ProductInfo | null>;
  getVariant(variantId: string): Promise<{ product: ProductInfo; variant: VariantInfo } | null>;
  findOrderByName(orderNumber: string): Promise<OrderInfo | null>;
  findOrdersByPhone(phone: string, limit?: number): Promise<OrderInfo[]>;
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  listProducts(first: number, after?: string | null): Promise<{ products: ProductInfo[]; nextCursor: string | null }>;
}

/** Thrown when Shopify cannot be reached / returns a server error. The AI must NOT guess in this case. */
export class ShopifyUnavailableError extends Error {
  constructor(message = "Shopify is unavailable") {
    super(message);
    this.name = "ShopifyUnavailableError";
  }
}

export class ShopifyNotConfiguredError extends Error {
  constructor() {
    super("Shopify credentials are not configured");
    this.name = "ShopifyNotConfiguredError";
  }
}

export function normalizeOrderNumber(input: string): string | null {
  const m = input.trim().match(/^#?\s*([A-Za-z]{0,6}-?\d{3,10})$/);
  return m ? m[1]!.toUpperCase() : null;
}
