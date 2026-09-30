import Link from "next/link";
import type { Channel, ConversationStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { timeAgo } from "@/lib/format";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

const CHANNELS: Channel[] = ["INSTAGRAM", "MESSENGER", "WHATSAPP", "TEST"];
const STATUSES: ConversationStatus[] = ["AI_ACTIVE", "HUMAN_REQUIRED", "HUMAN_ACTIVE", "RESOLVED"];

function filterHref(current: Record<string, string | undefined>, key: string, value?: string) {
  const p = new URLSearchParams();
  const next = { ...current, [key]: value };
  for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `/admin?${s}` : "/admin";
}

export default async function ConversationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const channel = CHANNELS.includes(sp.channel as Channel) ? (sp.channel as Channel) : undefined;
  const status = STATUSES.includes(sp.status as ConversationStatus) ? (sp.status as ConversationStatus) : undefined;
  const q = sp.q?.trim().slice(0, 80);

  const where: Prisma.ConversationWhereInput = {
    ...(channel ? { channel } : { channel: { not: "TEST" } }),
    ...(status ? { status } : {}),
    ...(q ? { OR: [{ customer: { name: { contains: q, mode: "insensitive" } } }, { channelUser: { username: { contains: q, mode: "insensitive" } } }, { lastMessagePreview: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const [conversations, counts] = await Promise.all([
    prisma.conversation.findMany({
      where,
      orderBy: [{ lastMessageAt: "desc" }],
      take: 100,
      include: { customer: { select: { id: true, name: true } }, channelUser: { select: { name: true, username: true } }, handoffs: { where: { resolvedAt: null }, take: 1 } },
    }),
    prisma.conversation.groupBy({ by: ["status"], where: { channel: { not: "TEST" } }, _count: true }),
  ]);
  const countOf = (s: string) => counts.find((c) => c.status === s)?._count ?? 0;

  return (
    <>
      <AutoRefresh seconds={10} />
      <h1>Conversations</h1>
      <div className="stats">
        {STATUSES.map((s) => (
          <Link key={s} href={filterHref(sp, "status", s)} className="stat" style={{ textDecoration: "none" }}>
            <div className="v">{countOf(s)}</div>
            <div className="l">{s.replace("_", " ")}</div>
          </Link>
        ))}
      </div>
      <div className="filters">
        <Link href={filterHref(sp, "channel")} className={!channel ? "on" : ""}>All channels</Link>
        {CHANNELS.map((c) => (
          <Link key={c} href={filterHref(sp, "channel", c)} className={channel === c ? "on" : ""}>
            {c.toLowerCase()}
          </Link>
        ))}
        <span style={{ width: 12 }} />
        <Link href={filterHref(sp, "status")} className={!status ? "on" : ""}>Any status</Link>
        {STATUSES.map((s) => (
          <Link key={s} href={filterHref(sp, "status", s)} className={status === s ? "on" : ""}>
            {s.replace("_", " ").toLowerCase()}
          </Link>
        ))}
      </div>
      <form className="row" style={{ marginBottom: 12 }}>
        {channel && <input type="hidden" name="channel" value={channel} />}
        {status && <input type="hidden" name="status" value={status} />}
        <input name="q" defaultValue={q} placeholder="Search customer or message…" style={{ maxWidth: 320 }} />
        <button type="submit">Search</button>
      </form>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Channel</th>
              <th>Last message</th>
              <th>Status</th>
              <th>Handled by</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {conversations.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">No conversations yet.</td>
              </tr>
            )}
            {conversations.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`/admin/conversations/${c.id}`}>
                    <strong>{c.customer.name ?? c.channelUser.name ?? "Unknown customer"}</strong>
                  </Link>
                  {c.channelUser.username && <div className="small muted">@{c.channelUser.username}</div>}
                </td>
                <td><span className={`badge ${c.channel}`}>{c.channel.toLowerCase()}</span></td>
                <td className="small" style={{ maxWidth: 380 }}>{c.lastMessagePreview ?? "—"}</td>
                <td>
                  <span className={`badge ${c.status}`}>{c.status}</span>
                  {c.handoffs[0] && <div className="small muted">{c.handoffs[0].reason.replace(/_/g, " ")}</div>}
                </td>
                <td className="small">{c.status === "AI_ACTIVE" ? "AI" : c.assignedTo ?? "Human (unassigned)"}</td>
                <td className="small muted">{timeAgo(c.lastMessageAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
