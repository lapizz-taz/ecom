"use client";
import { useState } from "react";
import { LoaderCircle, PackageSearch, Search, Truck } from "lucide-react";
import { CardHeader, OrderStatusPill } from "@/components/ui";

interface OrderInfo {
  name: string;
  createdAt: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  cancelled: boolean;
  total: number;
  currency: string;
  items: { title: string; variant: string | null; quantity: number }[];
  tracking: { company: string | null; number: string | null; url: string | null }[];
}

type Result = { kind: "order"; order: OrderInfo } | { kind: "none" } | { kind: "error"; text: string } | null;

export function OrderLookup() {
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);

  async function lookup(e?: React.FormEvent) {
    e?.preventDefault();
    if (!number.trim()) return;
    setBusy(true);
    setResult(null);
    const res = await fetch(`/api/shopify/orders?number=${encodeURIComponent(number)}`);
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setResult({ kind: "error", text: j.error ?? "Failed" });
    setResult(j.order ? { kind: "order", order: j.order } : { kind: "none" });
  }

  const o = result?.kind === "order" ? result.order : null;
  return (
    <div className="card">
      <CardHeader icon={PackageSearch} title="Shopify order lookup" description="Find any order by its number. Lookups are recorded in the audit log." />
      <div className="card-body">
        <form className="row" onSubmit={lookup}>
          <div className="search" style={{ maxWidth: 260 }}>
            <Search width={16} height={16} aria-hidden />
            <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="#1001" aria-label="Order number" />
          </div>
          <button className="btn-primary" disabled={!number.trim() || busy}>
            {busy && <LoaderCircle width={15} height={15} className="spin" aria-hidden />}
            Look up
          </button>
        </form>
        {result?.kind === "error" && <p className="feedback err" style={{ marginTop: 12 }}>{result.text}</p>}
        {result?.kind === "none" && <p className="small muted" style={{ marginTop: 12 }}>No order found with that number.</p>}
        {o && (
          <div className="card" style={{ marginTop: 14, background: "var(--surface-2)" }}>
            <div className="card-body">
              <div className="row" style={{ marginBottom: 12 }}>
                <span className="strong" style={{ fontSize: 16 }}>{o.name}</span>
                {o.cancelled && <OrderStatusPill status="CANCELLED" />}
                {o.financialStatus && <OrderStatusPill status={o.financialStatus} />}
                <OrderStatusPill status={o.fulfillmentStatus ?? "UNFULFILLED"} />
                <span className="spacer" />
                <span className="strong num">{o.currency} {o.total.toLocaleString("en-US")}</span>
              </div>
              <div className="small muted" style={{ marginBottom: 10 }}>Placed {new Date(o.createdAt).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" })}</div>
              <div className="stack-sm">
                {o.items.map((it, i) => (
                  <div key={i} className="row small" style={{ justifyContent: "space-between" }}>
                    <span>{it.title}{it.variant && it.variant !== "Default Title" ? <span className="muted"> · {it.variant}</span> : null}</span>
                    <span className="num muted">× {it.quantity}</span>
                  </div>
                ))}
              </div>
              {o.tracking.length > 0 && (
                <div className="row small" style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                  <Truck width={15} height={15} className="muted" aria-hidden />
                  {o.tracking.map((t, i) =>
                    t.url ? (
                      <a key={i} className="link" href={t.url} target="_blank" rel="noreferrer">{[t.company, t.number].filter(Boolean).join(" ") || "Tracking"}</a>
                    ) : (
                      <span key={i}>{[t.company, t.number].filter(Boolean).join(" ")}</span>
                    ),
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
