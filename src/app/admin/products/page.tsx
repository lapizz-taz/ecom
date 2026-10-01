"use client";
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, ImageOff, LoaderCircle, Package, Search, TriangleAlert, X } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui";

interface Variant { id: string; title: string; price: number; compareAtPrice: number | null; available: boolean; inventoryQuantity: number | null; tracked: boolean; sku: string | null }
interface Product { id: string; title: string; url: string; image: string | null; status: string; priceMin: number; priceMax: number; available: boolean; totalInventory: number | null; variants: Variant[]; productType: string | null }

const taka = (n: number) => `৳${n.toLocaleString("en-US")}`;

function SkeletonCard() {
  return (
    <div className="card product-card" aria-hidden>
      <div className="product-media skeleton" style={{ borderRadius: 0 }} />
      <div className="product-info">
        <div className="skeleton" style={{ height: 16, width: "80%" }} />
        <div className="skeleton" style={{ height: 14, width: "40%" }} />
        <div className="skeleton" style={{ height: 12, width: "60%", marginTop: 12 }} />
      </div>
    </div>
  );
}

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (opts: { q?: string; after?: string | null; append?: boolean }) => {
    setLoading(true);
    setError(null);
    const p = new URLSearchParams();
    if (opts.q) p.set("q", opts.q);
    if (opts.after) p.set("after", opts.after);
    const res = await fetch(`/api/shopify/products?${p}`);
    const j = await res.json().catch(() => ({}));
    setLoading(false);
    setLoaded(true);
    if (!res.ok) return setError(j.error ?? "Failed to load products");
    setProducts((prev) => (opts.append ? [...prev, ...j.products] : j.products));
    setCursor(j.nextCursor);
  }, []);

  useEffect(() => {
    load({});
  }, [load]);

  const firstLoad = loading && !loaded;
  return (
    <>
      <PageHeader title="Products & live stock" description="Live from Shopify — the single source of truth the AI uses for prices and stock." />
      <form
        className="toolbar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          load({ q });
        }}
      >
        <div className="search">
          <Search width={16} height={16} aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products…" aria-label="Search products" />
        </div>
        <button disabled={loading}>Search</button>
        {q && (
          <button type="button" className="btn-ghost" onClick={() => { setQ(""); load({}); }}>
            <X width={15} height={15} aria-hidden /> Clear
          </button>
        )}
      </form>

      {error && (
        <div className="alert alert-warning" style={{ marginBottom: 16 }}>
          <TriangleAlert width={18} height={18} aria-hidden />
          <div>
            <div className="alert-title">{error}</div>
            <div className="alert-body small">Check the Shopify settings in Vercel (SHOPIFY_STORE_DOMAIN and an access token), then reload.</div>
          </div>
        </div>
      )}

      {firstLoad ? (
        <div className="product-grid">{Array.from({ length: 8 }, (_, i) => <SkeletonCard key={i} />)}</div>
      ) : products.length === 0 && !error ? (
        <div className="card"><EmptyState icon={Package} title={q ? "No products match your search" : "No products"} /></div>
      ) : (
        <div className="product-grid">
          {products.map((p) => {
            const onSale = p.variants.some((v) => v.compareAtPrice && v.compareAtPrice > v.price);
            const maxCompare = Math.max(0, ...p.variants.map((v) => v.compareAtPrice ?? 0));
            return (
              <div key={p.id} className="card product-card">
                <div className="product-media">
                  {p.image ? (
                    <img src={`${p.image}${p.image.includes("?") ? "&" : "?"}width=480`} alt="" loading="lazy" />
                  ) : (
                    <ImageOff width={28} height={28} aria-hidden />
                  )}
                  <span className={`pill ${p.available ? "tone-good" : "tone-critical"}`}>{p.available ? "In stock" : "Out of stock"}</span>
                </div>
                <div className="product-info">
                  <a href={p.url} target="_blank" rel="noreferrer" className="product-title">
                    {p.title} <ExternalLink width={12} height={12} className="muted" aria-hidden />
                  </a>
                  <div className="row" style={{ gap: 6 }}>
                    {p.productType && <span className="small muted">{p.productType}</span>}
                    {p.status !== "ACTIVE" && <span className="pill tone-warning">{p.status.toLowerCase()}</span>}
                  </div>
                  <div className="price">
                    {taka(p.priceMin)}{p.priceMax !== p.priceMin ? ` – ${taka(p.priceMax)}` : ""}
                    {onSale && maxCompare > p.priceMax && <s>{taka(maxCompare)}</s>}
                  </div>
                  <div className="variant-list">
                    {p.variants.map((v) => (
                      <div key={v.id} className="variant">
                        <span className={`dot${v.available ? " on" : ""}`} style={v.available ? undefined : { background: "var(--critical-dot)" }} aria-hidden />
                        <span className="vname" title={v.sku ?? undefined}>{v.title === "Default Title" ? "Default" : v.title}</span>
                        <span className="num muted">
                          {v.available ? (v.tracked && v.inventoryQuantity !== null ? `${v.inventoryQuantity} left` : "Available") : "Sold out"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {cursor && !q && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 20 }}>
          <button disabled={loading} onClick={() => load({ after: cursor, append: true })}>
            {loading && <LoaderCircle width={15} height={15} className="spin" aria-hidden />}
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </>
  );
}
