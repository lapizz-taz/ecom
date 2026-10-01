import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, MessagesSquare, Phone, ReceiptText, ShoppingBag } from "lucide-react";
import { prisma } from "@/lib/db";
import { money, timeAgo } from "@/lib/format";
import { CustomerEditor } from "@/components/CustomerEditor";
import { Avatar, CardHeader, CHANNEL_LABEL, ChannelIcon, ChannelPill, EmptyState, OrderStatusPill, StatusPill } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await prisma.customer.findUnique({
    where: { id },
    include: {
      channelUsers: true,
      conversations: { orderBy: { lastMessageAt: "desc" }, take: 50 },
      orders: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
  if (!c) notFound();
  const last = c.orders[0];
  const name = c.name ?? "Unknown customer";
  const lifetime = c.orders.reduce((sum, o) => sum + (o.total ? Number(o.total) : 0), 0);
  return (
    <>
      <Link href="/admin/customers" className="back-link">
        <ArrowLeft width={15} height={15} aria-hidden /> Customers
      </Link>
      <div className="page-header">
        <div className="profile-head page-heading">
          <Avatar name={name} size="xl" />
          <div style={{ minWidth: 0 }}>
            <h1 className="truncate">{name}</h1>
            <div className="row" style={{ marginTop: 6, gap: 6 }}>
              {c.phone && (
                <span className="pill lg">
                  <Phone aria-hidden /> {c.phone}
                </span>
              )}
              {c.channelUsers.map((u) => (
                <span key={u.id} className={`pill lg ch-${u.channel}`}>
                  <ChannelIcon channel={u.channel} size={13} />
                  {u.username ? `@${u.username}` : CHANNEL_LABEL[u.channel]}
                </span>
              ))}
              {c.tags.map((t) => <span key={t} className="tag">{t}</span>)}
            </div>
          </div>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="stat-top"><span className="stat-icon tone-accent"><ShoppingBag aria-hidden /></span><span className="stat-label">Orders via chat</span></div>
          <div className="stat-value num">{c.orders.length}</div>
        </div>
        <div className="stat">
          <div className="stat-top"><span className="stat-icon tone-good"><ReceiptText aria-hidden /></span><span className="stat-label">Order value</span></div>
          <div className="stat-value num">{money(lifetime)}</div>
        </div>
        <div className="stat">
          <div className="stat-top"><span className="stat-icon tone-neutral"><MessagesSquare aria-hidden /></span><span className="stat-label">Conversations</span></div>
          <div className="stat-value num">{c.conversations.length}</div>
        </div>
        <div className="stat">
          <div className="stat-top"><span className="stat-icon tone-warning"><ReceiptText aria-hidden /></span><span className="stat-label">Last order</span></div>
          <div className="stat-value" style={{ fontSize: 20 }}>{last ? last.shopifyOrderName ?? "Draft" : "—"}</div>
          <div className="stat-note">{last ? timeAgo(last.createdAt) : "No orders yet"}</div>
        </div>
      </div>

      <div className="grid-main">
        <div className="stack">
          <div className="card flush">
            <CardHeader icon={MessagesSquare} title="Conversations" />
            {c.conversations.length === 0 ? (
              <EmptyState icon={MessagesSquare} title="No conversations" compact />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Channel</th><th>Status</th><th>Last message</th><th>Started</th></tr></thead>
                  <tbody>
                    {c.conversations.map((cv) => (
                      <tr key={cv.id}>
                        <td><Link href={`/admin/conversations/${cv.id}`}><ChannelPill channel={cv.channel} /></Link></td>
                        <td><StatusPill status={cv.status} /></td>
                        <td className="small" style={{ maxWidth: 360 }}>
                          <Link href={`/admin/conversations/${cv.id}`} className="clamp-2">{cv.lastMessagePreview ?? "—"}</Link>
                        </td>
                        <td className="small muted nowrap">{timeAgo(cv.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card flush">
            <CardHeader icon={ReceiptText} title="Orders" description="Orders placed through chat." />
            {c.orders.length === 0 ? (
              <EmptyState icon={ReceiptText} title="No orders placed through chat" compact />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Order</th><th>Status</th><th className="num">Total</th><th>Date</th></tr></thead>
                  <tbody>
                    {c.orders.map((o) => (
                      <tr key={o.id}>
                        <td className="strong">{o.shopifyOrderName ?? "Draft"}</td>
                        <td><OrderStatusPill status={o.status} /></td>
                        <td className="num">{money(o.total?.toString())}</td>
                        <td className="small muted nowrap">{timeAgo(o.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
        <CustomerEditor id={c.id} name={c.name} phone={c.phone} tags={c.tags} notes={c.notes} />
      </div>
    </>
  );
}
