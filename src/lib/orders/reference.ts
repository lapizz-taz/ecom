/** Short order reference for orders that have no Shopify order number, e.g. "ISO-K3Q9PX". */
export function orderReference(orderId: string): string {
  return `ISO-${orderId.slice(-6).toUpperCase()}`;
}

/** The number staff and customers know an order by. */
export function orderLabel(o: { id: string; shopifyOrderName: string | null; platformOrderId: string | null; status: string }): string {
  if (o.shopifyOrderName) return o.shopifyOrderName;
  if (o.platformOrderId) return o.platformOrderId;
  if (o.status === "draft_pending_review") return "Draft (pending review)";
  return orderReference(o.id);
}
