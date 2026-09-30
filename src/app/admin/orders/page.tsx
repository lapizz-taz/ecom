import Link from "next/link";
import { prisma } from "@/lib/db";
import { money, dateTime } from "@/lib/format";
import { OrderLookup } from "@/components/OrderLookup";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const [orders, failedDrafts] = await Promise.all([
    prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 100, include: { customer: { select: { id: true, name: true } } } }),
    prisma.draftOrder.findMany({ where: { status: "FAILED" }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  return (
    <>
      <h1>Orders</h1>
      <OrderLookup />
      {failedDrafts.length > 0 && (
        <div className="card">
          <h3 className="error">Orders that failed to submit automatically ({failedDrafts.length})</h3>
          {failedDrafts.map((d) => (
            <div key={d.id} className="small" style={{ marginBottom: 10 }}>
              <Link href={`/admin/conversations/${d.conversationId}`}>Open conversation →</Link> · {dateTime(d.createdAt)} · <span className="error">{d.error}</span>
              <pre>{((d.payload as { summaryLines?: string[] }).summaryLines ?? []).join("\n")}</pre>
            </div>
          ))}
        </div>
      )}
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Order</th><th>Customer</th><th>Channel</th><th>Status</th><th>Total</th><th>Created</th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td><strong>{o.shopifyOrderName ?? "Draft (pending review)"}</strong></td>
                <td><Link href={`/admin/customers/${o.customer.id}`}>{o.customer.name ?? "Unknown"}</Link></td>
                <td>{o.channel && <span className={`badge ${o.channel}`}>{o.channel.toLowerCase()}</span>}</td>
                <td>{o.status}</td>
                <td>{money(o.total?.toString())}</td>
                <td className="small">{dateTime(o.createdAt)}</td>
              </tr>
            ))}
            {orders.length === 0 && <tr><td colSpan={6} className="muted">No orders created through chat yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
