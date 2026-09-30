"use client";
import { useCallback, useEffect, useState } from "react";

interface Variant { id: string; title: string; price: number; compareAtPrice: number | null; available: boolean; inventoryQuantity: number | null; tracked: boolean; sku: string | null }
interface Product { id: string; title: string; url: string; image: string | null; status: string; priceMin: number; priceMax: number; available: boolean; totalInventory: number | null; variants: Variant[]; productType: string | null }

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (opts: { q?: string; after?: string | null; append?: boolean }) => {
    setLoading(true);
    setError(null);
    const p = new URLSearchParams();
    if (opts.q) p.set("q", opts.q);
    if (opts.after) p.set("after", opts.after);
    const res = await fetch(`/api/shopify/products?${p}`);
    const j = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) return setError(j.error ?? "Failed to load products");
    setProducts((prev) => (opts.append ? [...prev, ...j.products] : j.products));
    setCursor(j.nextCursor);
  }, []);

  useEffect(() => {
    load({});
  }, [load]);

  return (
    <>
      <h1>Products & live stock</h1>
      <p className="muted small">Live from Shopify — the single source of truth for prices and stock.</p>
      <div className="row" style={{ marginBottom: 12 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products…" style={{ maxWidth: 320 }} onKeyDown={(e) => e.key === "Enter" && load({ q })} />
        <button onClick={() => load({ q })}>Search</button>
        {q && <button onClick={() => { setQ(""); load({}); }}>Clear</button>}
      </div>
      {error && <div className="card error">{error}</div>}
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th></th><th>Product</th><th>Price</th><th>Variants / stock</th><th>Status</th></tr></thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td style={{ width: 56 }}>{p.image && <img src={`${p.image}${p.image.includes("?") ? "&" : "?"}width=96`} alt="" width={48} height={48} style={{ objectFit: "cover", borderRadius: 6 }} />}</td>
                <td><a href={p.url} target="_blank" rel="noreferrer"><strong>{p.title}</strong></a><div className="small muted">{p.productType}</div></td>
                <td>৳{p.priceMin}{p.priceMax !== p.priceMin ? `–${p.priceMax}` : ""}</td>
                <td className="small">
                  {p.variants.map((v) => (
                    <div key={v.id}>
                      {v.title === "Default Title" ? "Default" : v.title}: {v.available ? <span className="success">available</span> : <span className="error">out of stock</span>}
                      {v.tracked && v.inventoryQuantity !== null ? ` (${v.inventoryQuantity})` : ""} · ৳{v.price}
                      {v.compareAtPrice ? <span className="muted"> (was ৳{v.compareAtPrice})</span> : null}
                    </div>
                  ))}
                </td>
                <td><span className="badge">{p.status}</span></td>
              </tr>
            ))}
            {!loading && products.length === 0 && !error && <tr><td colSpan={5} className="muted">No products.</td></tr>}
          </tbody>
        </table>
      </div>
      {cursor && !q && <button disabled={loading} onClick={() => load({ after: cursor, append: true })}>{loading ? "Loading…" : "Load more"}</button>}
    </>
  );
}
