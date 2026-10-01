import Link from "next/link";
import { ArrowUpRight, ReceiptText, TriangleAlert } from "lucide-react";
import { prisma } from "@/lib/db";
import { money, dateTime } from "@/lib/format";
import { OrderLookup } from "@/components/OrderLookup";
import { Avatar, ChannelPill, EmptyState, OrderStatusPill, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const [orders, failedDrafts] = await Promise.all([
    prisma.order.findMany({ orderBy: { createdAt: "desc" }, take: 100, include: { customer: { select: { id: true, name: true } } } }),
    prisma.draftOrder.findMany({ where: { status: "FAILED" }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  return (
    <>
      <PageHeader title="Orders" description="Orders the AI created through chat, plus a quick lookup for any Shopify order." />
      <div className="stack">
        {failedDrafts.length > 0 && (
          <div className="alert alert-critical">
            <TriangleAlert width={18} height={18} aria-hidden />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="alert-title">
                {failedDrafts.length} {failedDrafts.length === 1 ? "order" : "orders"} failed to submit automatically
              </div>
              <div className="alert-body small" style={{ marginBottom: 8 }}>Open each conversation and place the order manually in Shopify.</div>
              <div className="stack-sm">
                {failedDrafts.map((d) => (
                  <div key={d.id} className="card" style={{ padding: "10px 12px" }}>
                    <div className="row">
                      <span className="small muted">{dateTime(d.createdAt)}</span>
                      <span className="small error" style={{ flex: "1 1 200px" }}>{d.error}</span>
                      <Link href={`/admin/conversations/${d.conversationId}`} className="btn btn-sm">
                        Open conversation <ArrowUpRight width={14} height={14} aria-hidden />
                      </Link>
                    </div>
                    <pre>{((d.payload as { summaryLines?: string[] }).summaryLines ?? []).join("\n")}</pre>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <OrderLookup />

        <div className="card flush">
          <div className="card-header">
            <div style={{ flex: 1 }}>
              <h2 className="card-title"><ReceiptText width={17} height={17} aria-hidden /> Orders from chat</h2>
              <p className="card-desc">Latest 100 orders created by the assistant.</p>
            </div>
          </div>
          {orders.length === 0 ? (
            <EmptyState icon={ReceiptText} title="No orders yet">Orders the AI creates in Shopify will be listed here.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Order</th><th>Customer</th><th>Channel</th><th>Status</th><th className="num">Total</th><th>Created</th></tr></thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td className="strong nowrap">{o.shopifyOrderName ?? "Draft (pending review)"}</td>
                      <td>
                        <Link href={`/admin/customers/${o.customer.id}`} className="cell-person">
                          <Avatar name={o.customer.name ?? "Unknown"} size="sm" />
                          <span className="name">{o.customer.name ?? "Unknown"}</span>
                        </Link>
                      </td>
                      <td>{o.channel && <ChannelPill channel={o.channel} />}</td>
                      <td><OrderStatusPill status={o.status} /></td>
                      <td className="num strong">{money(o.total?.toString())}</td>
                      <td className="small muted nowrap">{dateTime(o.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
