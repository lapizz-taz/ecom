"use client";
import { useState } from "react";

export function OrderLookup() {
  const [number, setNumber] = useState("");
  const [result, setResult] = useState<string | null>(null);
  async function lookup() {
    setResult("Loading…");
    const res = await fetch(`/api/shopify/orders?number=${encodeURIComponent(number)}`);
    const j = await res.json().catch(() => ({}));
    setResult(res.ok ? JSON.stringify(j.order ?? "Not found", null, 2) : j.error ?? "Failed");
  }
  return (
    <div className="card">
      <h3>Shopify order lookup (staff)</h3>
      <div className="row">
        <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="#1001" style={{ maxWidth: 200 }} />
        <button onClick={lookup} disabled={!number.trim()}>Look up</button>
      </div>
      {result && <pre>{result}</pre>}
    </div>
  );
}
