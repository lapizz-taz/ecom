import Link from "next/link";
import { ArrowUpRight, ReceiptText, Send, TriangleAlert } from "lucide-react";
import { prisma } from "@/lib/db";
import { money, dateTime, timeAgo } from "@/lib/format";
import { integrationEnv } from "@/lib/integrations";
import { orderDestination } from "@/lib/orders/forward";
import { orderLabel } from "@/lib/orders/reference";
import { OrderLookup } from "@/components/OrderLookup";
import { ResendOrderButton } from "@/components/ResendOrderButton";
import { Avatar, ChannelPill, EmptyState, OrderStatusPill, PageHeader } from "@/components/ui";

const FORWARD_PILL: Record<string, { tone: string; label: string }> = {
  sent: { tone: "tone-good", label: "Delivered" },
  pending: { tone: "tone-warning", label: "Retrying" },
  failed: { tone: "tone-critical", label: "Not delivered" },
};

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const [orders, failedDrafts, undelivered, e] = await Promise.all([
    prisma.order.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { customer: { select: { id: true, name: true } }, forwards: { select: { id: true, status: true, externalId: true, error: true } } },
    }),
    prisma.draftOrder.findMany({ where: { status: "FAILED" }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.orderForward.findMany({ where: { status: { in: ["pending", "failed"] } }, orderBy: { createdAt: "desc" }, take: 20, include: { order: true } }),
    integrationEnv(),
  ]);
  const destination = orderDestination(e);
  const showPlatform = destination !== "shopify" || orders.some((o) => o.forwards.length > 0);
  const gaveUp = undelivered.some((f) => f.status === "failed");
  return (
    <>
      <PageHeader
        title="Orders"
        description={`Orders the AI took through chat${destination === "platform" ? " and sent to your order platform" : destination === "both" ? " — in Shopify and your order platform" : ""}, plus a quick lookup for any Shopify order.`}
      />
      <div className="stack">
        {undelivered.length > 0 && (
          <div className={`alert ${gaveUp ? "alert-critical" : "alert-warning"}`}>
            <Send width={18} height={18} aria-hidden />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="alert-title">
                {undelivered.length} {undelivered.length === 1 ? "order hasn't" : "orders haven't"} reached your order platform yet
              </div>
              <div className="alert-body small" style={{ marginBottom: 8 }}>
                {gaveUp ? "Automatic retries gave up on some — fix the connection on the Integrations page, then click Resend, or add them by hand." : "They're retried automatically. You can also resend them now."}
              </div>
              <div className="stack-sm">
                {undelivered.map((f) => (
                  <div key={f.id} className="card" style={{ padding: "10px 12px" }}>
                    <div className="row">
                      <span className="strong nowrap">{orderLabel(f.order)}</span>
                      <span className={`pill ${FORWARD_PILL[f.status]?.tone ?? ""}`}>{FORWARD_PILL[f.status]?.label ?? f.status}</span>
                      <span className="small text-2" style={{ flex: "1 1 220px", minWidth: 0 }}>
                        {f.error ?? "Waiting to be sent"}
                        {f.attempts ? ` · ${f.attempts} ${f.attempts === 1 ? "try" : "tries"} · first ${timeAgo(f.createdAt)}` : ""}
                      </span>
                      <ResendOrderButton forwardId={f.id} />
                      {f.order.conversationId && (
                        <Link href={`/admin/conversations/${f.order.conversationId}`} className="btn btn-sm">
                          Conversation <ArrowUpRight width={14} height={14} aria-hidden />
                        </Link>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {failedDrafts.length > 0 && (
          <div className="alert alert-critical">
            <TriangleAlert width={18} height={18} aria-hidden />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="alert-title">
                {failedDrafts.length} {failedDrafts.length === 1 ? "order" : "orders"} failed to submit automatically
              </div>
              <div className="alert-body small" style={{ marginBottom: 8 }}>Open each conversation and place the order by hand{destination === "platform" ? " in your order platform" : " in Shopify"}.</div>
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
            <EmptyState icon={ReceiptText} title="No orders yet">Orders the AI takes in chat will be listed here.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Order</th><th>Customer</th><th>Channel</th><th>Status</th>
                    {showPlatform && <th>Order platform</th>}
                    <th className="num">Total</th><th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td className="strong nowrap">{orderLabel(o)}</td>
                      <td>
                        <Link href={`/admin/customers/${o.customer.id}`} className="cell-person">
                          <Avatar name={o.customer.name ?? "Unknown"} size="sm" />
                          <span className="name">{o.customer.name ?? "Unknown"}</span>
                        </Link>
                      </td>
                      <td>{o.channel && <ChannelPill channel={o.channel} />}</td>
                      <td><OrderStatusPill status={o.status} /></td>
                      {showPlatform && (
                        <td>
                          {o.forwards[0] ? (
                            <span className={`pill ${FORWARD_PILL[o.forwards[0].status]?.tone ?? ""}`} title={o.forwards[0].error ?? o.forwards[0].externalId ?? undefined}>
                              {FORWARD_PILL[o.forwards[0].status]?.label ?? o.forwards[0].status}
                            </span>
                          ) : (
                            <span className="small muted">Not sent</span>
                          )}
                        </td>
                      )}
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
