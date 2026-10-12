// Views whose Postgres definition used functions SQLite does not have, written by
// hand in SQLite. Like the converted ones they are inlined into each query after the
// row-security filters (all views were security_invoker). {{setting:…}} is the
// current store's setting (Postgres setting_numeric / setting_text).

const lowStockThreshold = "COALESCE(p.low_stock_threshold, CAST(round(COALESCE(CAST({{setting:inventory.low_stock_threshold}} AS REAL), 5)) AS INTEGER))"

export const handViews: Record<string, string> = {
  inventory_overview: `SELECT v.id AS variant_id, p.id AS product_id, p.name AS product_name, p.slug AS product_slug,
      p.status AS product_status, p.track_inventory, c.name AS category_name, v.sku, v.title AS variant_title,
      v.is_active AS variant_active, COALESCE(v.cost_price, p.cost_price) AS unit_cost, COALESCE(v.price, p.price) AS unit_price,
      i.on_hand, i.reserved, i.available, i.damaged,
      ${lowStockThreshold} AS low_stock_threshold,
      CASE WHEN NOT p.track_inventory THEN 'UNTRACKED'
           WHEN i.available <= 0 THEN 'OUT_OF_STOCK'
           WHEN i.available <= ${lowStockThreshold} THEN 'LOW_STOCK'
           ELSE 'IN_STOCK' END AS stock_status,
      round(i.on_hand * COALESCE(v.cost_price, p.cost_price), 2) AS stock_value,
      i.updated_at
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    JOIN inventory i ON i.variant_id = v.id
    LEFT JOIN categories c ON c.id = p.category_id`,
}
