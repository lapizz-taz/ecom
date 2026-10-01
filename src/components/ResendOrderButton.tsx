"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, RefreshCw } from "lucide-react";

/** Sends an order to the order platform again (Orders page). */
export function ResendOrderButton({ forwardId }: { forwardId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resend() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/admin/orders/forward", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ forwardId }) });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string | null };
    if (!res.ok || !data.ok) setError(data.error ?? "Still not delivered");
    setBusy(false);
    router.refresh();
  }

  return (
    <span className="row" style={{ gap: 6 }}>
      <button type="button" className="btn-sm" onClick={resend} disabled={busy}>
        {busy ? <LoaderCircle width={14} height={14} className="spin" /> : <RefreshCw width={14} height={14} />} Resend
      </button>
      {error && <span className="tiny error" role="alert">{error}</span>}
    </span>
  );
}
