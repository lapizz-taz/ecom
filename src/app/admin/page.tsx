import Link from "next/link";
import { Inbox, Search, X } from "lucide-react";
import type { Channel, ConversationStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { timeAgo } from "@/lib/format";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Avatar, CHANNEL_LABEL, ChannelIcon, EmptyState, PageHeader, STATUS_META, StatusPill, humanize } from "@/components/ui";

export const dynamic = "force-dynamic";

const CHANNELS: Channel[] = ["INSTAGRAM", "MESSENGER", "WHATSAPP", "TEST"];
const STATUSES: ConversationStatus[] = ["HUMAN_REQUIRED", "AI_ACTIVE", "HUMAN_ACTIVE", "RESOLVED"];

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
  const filtered = Boolean(channel || status || q);

  return (
    <>
      <AutoRefresh seconds={10} />
      <PageHeader
        title="Inbox"
        description="Every Instagram, Messenger and WhatsApp conversation in one place."
        actions={
          <span className="live">
            <span className="pulse" /> Live · updates every 10s
          </span>
        }
      />

      <div className="stat-grid">
        {STATUSES.map((s) => {
          const meta = STATUS_META[s];
          const Icon = meta.icon;
          const n = countOf(s);
          return (
            <Link
              key={s}
              href={filterHref(sp, "status", status === s ? undefined : s)}
              className={`stat${status === s ? " active" : ""}${s === "HUMAN_REQUIRED" && n > 0 ? " alert" : ""}`}
              aria-current={status === s ? "true" : undefined}
            >
              <div className="stat-top">
                <span className={`stat-icon tone-${meta.tone}`}>
                  <Icon aria-hidden />
                </span>
                <span className="stat-label">{meta.label}</span>
              </div>
              <div className="stat-value num">{n}</div>
              <div className="stat-note">{meta.hint}</div>
            </Link>
          );
        })}
      </div>

      <div className="card flush">
        <div className="toolbar" style={{ padding: "14px 16px", margin: 0, borderBottom: "1px solid var(--border)" }}>
          <form className="search" role="search">
            {channel && <input type="hidden" name="channel" value={channel} />}
            {status && <input type="hidden" name="status" value={status} />}
            <Search width={16} height={16} aria-hidden />
            <input name="q" defaultValue={q} placeholder="Search customer or message…" aria-label="Search conversations" />
          </form>
          <div className="segmented" aria-label="Filter by channel">
            <Link href={filterHref(sp, "channel")} className={!channel ? "on" : ""}>All</Link>
            {CHANNELS.map((c) => (
              <Link key={c} href={filterHref(sp, "channel", c)} className={channel === c ? "on" : ""}>
                <ChannelIcon channel={c} size={14} />
                {CHANNEL_LABEL[c]}
              </Link>
            ))}
          </div>
          {filtered && (
            <Link href="/admin" className="btn btn-ghost btn-sm">
              <X width={14} height={14} aria-hidden /> Clear filters
            </Link>
          )}
        </div>

        {conversations.length > 0 && (
          <div className="conv-head" style={{ borderRadius: 0 }}>
            <span />
            <span>Customer</span>
            <span>Last message</span>
            <span>Status</span>
            <span style={{ textAlign: "right" }}>Updated</span>
          </div>
        )}
        <div className="conv-list">
          {conversations.length === 0 && (
            <EmptyState icon={Inbox} title={filtered ? "No conversations match these filters" : "No conversations yet"}>
              {filtered ? (
                <Link href="/admin" className="link">Clear filters</Link>
              ) : (
                "Messages from Instagram, Messenger and WhatsApp will appear here as soon as customers write in."
              )}
            </EmptyState>
          )}
          {conversations.map((c) => {
            const name = c.customer.name ?? c.channelUser.name ?? "Unknown customer";
            const handler = c.status === "AI_ACTIVE" ? null : c.assignedTo ?? (c.status === "RESOLVED" ? null : "Unassigned");
            return (
              <Link key={c.id} href={`/admin/conversations/${c.id}`} className={`conv-row${c.status === "HUMAN_REQUIRED" ? " urgent" : ""}`}>
                <Avatar name={name} />
                <div className="conv-who">
                  <div className="conv-name">
                    <span className="truncate">{name}</span>
                  </div>
                  <div className="conv-sub">
                    <span className={`pill ch-${c.channel}`} style={{ height: 20, padding: "0 7px" }}>
                      <ChannelIcon channel={c.channel} size={12} />
                      {CHANNEL_LABEL[c.channel]}
                    </span>
                    {c.channelUser.username && <span className="truncate">@{c.channelUser.username}</span>}
                  </div>
                </div>
                <div className="conv-preview">
                  <div className="clamp-2">{c.lastMessagePreview ?? "—"}</div>
                  {c.handoffs[0] && <div className="conv-reason">Reason: {humanize(c.handoffs[0].reason)}</div>}
                </div>
                <div className="conv-status">
                  <StatusPill status={c.status} />
                  {handler && <div className="tiny muted truncate" style={{ marginTop: 4 }}>{handler}</div>}
                </div>
                <div className="conv-time">{timeAgo(c.lastMessageAt)}</div>
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}
