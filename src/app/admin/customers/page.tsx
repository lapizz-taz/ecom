import Link from "next/link";
import { Search, Users } from "lucide-react";
import { prisma } from "@/lib/db";
import { timeAgo } from "@/lib/format";
import { Avatar, CHANNEL_LABEL, ChannelIcon, EmptyState, PageHeader } from "@/components/ui";

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
      <PageHeader title="Customers" description="Everyone who has messaged Isolation, merged across channels when their phone is verified." />
      <div className="card flush">
        <div className="toolbar" style={{ padding: "14px 16px", margin: 0, borderBottom: "1px solid var(--border)" }}>
          <form className="search" role="search">
            <Search width={16} height={16} aria-hidden />
            <input name="q" defaultValue={q} placeholder="Search by name, phone or tag…" aria-label="Search customers" />
          </form>
          <span className="spacer" />
          <span className="small muted">{customers.length} {customers.length === 1 ? "customer" : "customers"}{customers.length === 100 ? " (latest 100)" : ""}</span>
        </div>
        {customers.length === 0 ? (
          <EmptyState icon={Users} title={q ? "No customers match your search" : "No customers yet"}>
            {q ? <Link href="/admin/customers" className="link">Clear search</Link> : "Customers appear here after their first message."}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Phone</th>
                  <th>Channels</th>
                  <th className="num">Conversations</th>
                  <th className="num">Orders</th>
                  <th>Last order</th>
                  <th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/admin/customers/${c.id}`} className="cell-person">
                        <Avatar name={c.name ?? "Unknown"} size="sm" />
                        <span className="name">{c.name ?? "Unknown"}</span>
                      </Link>
                    </td>
                    <td className="small nowrap">
                      {c.phone ?? <span className="muted">—</span>}
                      {c.phone && c.phoneVerified && <span className="pill tone-good" style={{ marginLeft: 6 }}>Verified</span>}
                    </td>
                    <td>
                      <span className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                        {[...new Set(c.channelUsers.map((u) => u.channel))].map((ch) => (
                          <span key={ch} className={`pill ch-${ch}`} title={CHANNEL_LABEL[ch]}>
                            <ChannelIcon channel={ch} size={13} />
                            {CHANNEL_LABEL[ch]}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="num">{c._count.conversations}</td>
                    <td className="num">{c._count.orders}</td>
                    <td className="small nowrap">{c.orders[0] ? <><span className="strong">{c.orders[0].shopifyOrderName ?? "Draft"}</span> <span className="muted">· {timeAgo(c.orders[0].createdAt)}</span></> : <span className="muted">—</span>}</td>
                    <td>{c.tags.length ? <span className="tags">{c.tags.map((t) => <span key={t} className="tag">{t}</span>)}</span> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
