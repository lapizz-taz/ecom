import Link from "next/link";
import { prisma } from "@/lib/db";
import { timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = (await searchParams).q?.trim().slice(0, 80);
  const customers = await prisma.customer.findMany({
    where: {
      channelUsers: { some: { channel: { not: "TEST" } } },
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }, { tags: { has: q } }] } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: {
      channelUsers: { select: { channel: true } },
      orders: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { conversations: true, orders: true } },
    },
  });
  return (
    <>
      <h1>Customers</h1>
      <form className="row" style={{ marginBottom: 12 }}>
        <input name="q" defaultValue={q} placeholder="Name, phone or tag…" style={{ maxWidth: 320 }} />
        <button type="submit">Search</button>
      </form>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr><th>Name</th><th>Phone</th><th>Channels</th><th>Conversations</th><th>Orders</th><th>Last order</th><th>Tags</th></tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id}>
                <td><Link href={`/admin/customers/${c.id}`}><strong>{c.name ?? "Unknown"}</strong></Link></td>
                <td className="small">{c.phone ?? "—"}</td>
                <td>{[...new Set(c.channelUsers.map((u) => u.channel))].map((ch) => <span key={ch} className={`badge ${ch}`} style={{ marginRight: 4 }}>{ch.toLowerCase()}</span>)}</td>
                <td>{c._count.conversations}</td>
                <td>{c._count.orders}</td>
                <td className="small">{c.orders[0] ? `${c.orders[0].shopifyOrderName ?? "draft"} · ${timeAgo(c.orders[0].createdAt)}` : "—"}</td>
                <td>{c.tags.map((t) => <span key={t} className="badge" style={{ marginRight: 4 }}>{t}</span>)}</td>
              </tr>
            ))}
            {customers.length === 0 && <tr><td colSpan={7} className="muted">No customers yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
