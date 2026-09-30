import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { money, timeAgo } from "@/lib/format";
import { CustomerEditor } from "@/components/CustomerEditor";

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
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link href="/admin/customers" className="small">← Customers</Link>
      </div>
      <h1>{c.name ?? "Unknown customer"}</h1>
      <div className="stats">
        <div className="stat"><div className="v">{c.orders.length}</div><div className="l">Total orders (via chat)</div></div>
        <div className="stat"><div className="v">{c.conversations.length}</div><div className="l">Conversations</div></div>
        <div className="stat"><div className="v small">{last ? `${last.shopifyOrderName ?? "draft"}` : "—"}</div><div className="l">Last order {last ? timeAgo(last.createdAt) : ""}</div></div>
      </div>
      <div className="grid grid-3">
        <div>
          <div className="card">
            <h3>Channels</h3>
            {c.channelUsers.map((u) => (
              <div key={u.id} className="small" style={{ marginBottom: 4 }}>
                <span className={`badge ${u.channel}`}>{u.channel.toLowerCase()}</span> {u.name ?? ""} {u.username ? `@${u.username}` : ""}
              </div>
            ))}
          </div>
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead><tr><th>Conversation</th><th>Status</th><th>Last message</th></tr></thead>
              <tbody>
                {c.conversations.map((cv) => (
                  <tr key={cv.id}>
                    <td><Link href={`/admin/conversations/${cv.id}`}><span className={`badge ${cv.channel}`}>{cv.channel.toLowerCase()}</span> {timeAgo(cv.createdAt)}</Link></td>
                    <td><span className={`badge ${cv.status}`}>{cv.status}</span></td>
                    <td className="small">{cv.lastMessagePreview}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead><tr><th>Order</th><th>Status</th><th>Total</th><th>Date</th></tr></thead>
              <tbody>
                {c.orders.map((o) => (
                  <tr key={o.id}><td>{o.shopifyOrderName ?? "draft"}</td><td>{o.status}</td><td>{money(o.total?.toString())}</td><td className="small">{timeAgo(o.createdAt)}</td></tr>
                ))}
                {c.orders.length === 0 && <tr><td colSpan={4} className="muted">No orders placed through chat.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <CustomerEditor id={c.id} name={c.name} phone={c.phone} tags={c.tags} notes={c.notes} />
      </div>
    </>
  );
}
