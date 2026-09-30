import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { dateTime, money, timeAgo } from "@/lib/format";
import { maskPhone } from "@/lib/security/redact";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ConversationActions } from "@/components/ConversationActions";

export const dynamic = "force-dynamic";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const conv = await prisma.conversation.findUnique({
    where: { id },
    include: {
      customer: { include: { orders: { orderBy: { createdAt: "desc" }, take: 5 }, _count: { select: { conversations: true, orders: true } } } },
      channelUser: true,
      messages: { orderBy: { createdAt: "asc" }, take: 500 },
      handoffs: { orderBy: { createdAt: "desc" }, take: 10 },
      drafts: { orderBy: { createdAt: "desc" }, take: 3 },
      toolCalls: { orderBy: { createdAt: "desc" }, take: 30 },
    },
  });
  if (!conv) notFound();
  const c = conv.customer;

  return (
    <>
      <AutoRefresh seconds={8} />
      <div className="row" style={{ marginBottom: 12 }}>
        <Link href="/admin" className="small">← Conversations</Link>
      </div>
      <h1>
        {c.name ?? conv.channelUser.name ?? "Unknown customer"} <span className={`badge ${conv.channel}`}>{conv.channel.toLowerCase()}</span>{" "}
        <span className={`badge ${conv.status}`}>{conv.status}</span>
      </h1>
      <div className="grid grid-3">
        <div>
          <div className="card">
            <div className="thread">
              {conv.messages.map((m) => (
                <div key={m.id} className={`bubble ${m.sender}`}>
                  {m.message}
                  <div className="meta">
                    {m.sender === "HUMAN" ? m.sentBy ?? "team" : m.sender.toLowerCase()} · {dateTime(m.createdAt)}
                    {m.deliveryStatus === "FAILED" && <span> · ⚠️ not delivered{m.deliveryError ? `: ${m.deliveryError}` : ""}</span>}
                    {m.sender === "AI" && (m.metadata as { guard?: string } | null)?.guard && <span> · guard: {(m.metadata as { guard: string }).guard}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <ConversationActions conversationId={conv.id} status={conv.status} />
          <details className="card">
            <summary>AI tool calls ({conv.toolCalls.length})</summary>
            {conv.toolCalls.map((t) => (
              <div key={t.id} style={{ marginTop: 10 }}>
                <strong>{t.tool}</strong> <span className={`badge ${t.success ? "ok" : "bad"}`}>{t.success ? "ok" : "failed"}</span>{" "}
                <span className="small muted">{t.durationMs}ms · {timeAgo(t.createdAt)}</span>
                <pre>{JSON.stringify(t.input, null, 1)}</pre>
                <pre>{JSON.stringify(t.output, null, 1)}</pre>
              </div>
            ))}
          </details>
        </div>
        <div>
          <div className="card">
            <h3>Customer</h3>
            <div className="kv small">
              <div>Name</div><div>{c.name ?? "—"}</div>
              <div>Phone</div><div>{c.phone ?? "—"} {c.phone && (c.phoneVerified ? <span className="badge ok">verified</span> : <span className="badge">unverified</span>)}</div>
              <div>Channel ID</div><div title={conv.channelUser.externalUserId}>{conv.channel === "WHATSAPP" ? maskPhone(conv.channelUser.externalUserId) : `${conv.channelUser.externalUserId.slice(0, 6)}…`}</div>
              <div>Conversations</div><div>{c._count.conversations}</div>
              <div>Orders (chat)</div><div>{c._count.orders}</div>
              <div>Tags</div><div>{c.tags.length ? c.tags.map((t) => <span key={t} className="badge" style={{ marginRight: 4 }}>{t}</span>) : "—"}</div>
            </div>
            <div style={{ marginTop: 10 }}>
              <Link href={`/admin/customers/${c.id}`} className="small">Full profile →</Link>
            </div>
          </div>
          <div className="card">
            <h3>Handoffs</h3>
            {conv.handoffs.length === 0 && <div className="small muted">None</div>}
            {conv.handoffs.map((h) => (
              <div key={h.id} className="small" style={{ marginBottom: 8 }}>
                <strong>{h.reason.replace(/_/g, " ")}</strong> · {timeAgo(h.createdAt)} {h.resolvedAt ? <span className="badge ok">resolved</span> : <span className="badge bad">open</span>}
                {h.detail && <div className="muted">{h.detail}</div>}
              </div>
            ))}
          </div>
          <div className="card">
            <h3>Draft orders</h3>
            {conv.drafts.length === 0 && <div className="small muted">None</div>}
            {conv.drafts.map((d) => (
              <div key={d.id} className="small" style={{ marginBottom: 8 }}>
                <span className="badge">{d.status}</span> {money(d.total.toString())} · {timeAgo(d.createdAt)}
                <pre>{((d.payload as { summaryLines?: string[] }).summaryLines ?? []).join("\n")}</pre>
                {d.error && <div className="error">{d.error}</div>}
              </div>
            ))}
          </div>
          <div className="card">
            <h3>Recent orders</h3>
            {c.orders.length === 0 && <div className="small muted">None</div>}
            {c.orders.map((o) => (
              <div key={o.id} className="small">
                {o.shopifyOrderName ?? "draft"} · {o.status} · {money(o.total?.toString())} · {timeAgo(o.createdAt)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
