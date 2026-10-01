import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, ChevronRight, CircleAlert, FileText, Headset, ReceiptText, Sparkles, TriangleAlert, Wrench } from "lucide-react";
import { prisma } from "@/lib/db";
import { dayLabel, money, timeAgo, timeOnly } from "@/lib/format";
import { maskPhone } from "@/lib/security/redact";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ReplyComposer, StatusActions } from "@/components/ConversationActions";
import { Avatar, CardHeader, ChannelPill, EmptyState, OrderStatusPill, StatusPill, humanize } from "@/components/ui";

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
  const name = c.name ?? conv.channelUser.name ?? "Unknown customer";
  const openHandoff = conv.handoffs.find((h) => !h.resolvedAt);

  return (
    <>
      <AutoRefresh seconds={8} />
      <Link href="/admin" className="back-link">
        <ArrowLeft width={15} height={15} aria-hidden /> Inbox
      </Link>
      <div className="grid-main">
        <div className="stack">
          <div className="card chat">
            <div className="chat-header">
              <Avatar name={name} />
              <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                <div className="chat-title">
                  <span className="truncate">{name}</span>
                  <ChannelPill channel={conv.channel} />
                  <StatusPill status={conv.status} />
                </div>
                <div className="small muted truncate">
                  {conv.channelUser.username ? `@${conv.channelUser.username} · ` : ""}
                  {conv.status === "AI_ACTIVE" ? "The AI is replying" : conv.assignedTo ? `Assigned to ${conv.assignedTo}` : "Not assigned yet"}
                </div>
              </div>
              <StatusActions conversationId={conv.id} status={conv.status} />
            </div>

            {openHandoff && (
              <div className="alert alert-critical" style={{ borderRadius: 0, borderWidth: "0 0 1px" }}>
                <CircleAlert width={17} height={17} aria-hidden />
                <div>
                  <div className="alert-title">Needs attention: {humanize(openHandoff.reason)}</div>
                  {openHandoff.detail && <div className="alert-body small">{openHandoff.detail}</div>}
                </div>
              </div>
            )}

            <div className="thread">
              <div className="thread-inner">
                {conv.messages.length === 0 && <p className="muted small" style={{ textAlign: "center" }}>No messages yet.</p>}
                {conv.messages.map((m, i) => {
                  const prev = conv.messages[i - 1];
                  const newDay = !prev || dayLabel(prev.createdAt) !== dayLabel(m.createdAt);
                  const side = m.sender === "CUSTOMER" ? "in" : m.sender === "SYSTEM" ? "sys" : "out";
                  const guard = m.sender === "AI" ? (m.metadata as { guard?: string } | null)?.guard : undefined;
                  const failed = m.deliveryStatus === "FAILED";
                  return (
                    <div key={m.id} style={{ display: "contents" }}>
                      {newDay && <div className="day-sep">{dayLabel(m.createdAt)}</div>}
                      <div className={`msg ${side} ${m.sender.toLowerCase()}${failed ? " failed" : ""}`}>
                        <div className="bubble">
                          {m.sender === "SYSTEM" && <Headset width={13} height={13} aria-hidden />}
                          {m.message}
                        </div>
                        {m.sender !== "SYSTEM" && (
                          <div className="msg-meta">
                            {m.sender === "AI" && <Sparkles aria-hidden />}
                            <span>{m.sender === "HUMAN" ? m.sentBy ?? "Team" : m.sender === "AI" ? "AI assistant" : name}</span>
                            <span>·</span>
                            <span>{timeOnly(m.createdAt)}</span>
                            {guard && <span>· guard: {guard}</span>}
                            {failed && (
                              <span className="warn">
                                <TriangleAlert aria-hidden /> Not delivered{m.deliveryError ? `: ${m.deliveryError}` : ""}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <ReplyComposer conversationId={conv.id} />
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-body">
              <div className="profile-head">
                <Avatar name={name} size="lg" />
                <div style={{ minWidth: 0 }}>
                  <div className="strong truncate">{name}</div>
                  <div className="small muted">Customer since {timeAgo(c.createdAt)}</div>
                </div>
              </div>
              <dl className="kv" style={{ marginTop: 16 }}>
                <dt>Phone</dt>
                <dd>
                  {c.phone ?? "—"}{" "}
                  {c.phone && (c.phoneVerified ? <span className="pill tone-good">Verified</span> : <span className="pill">Unverified</span>)}
                </dd>
                <dt>Channel ID</dt>
                <dd className="mono" title={conv.channelUser.externalUserId}>
                  {conv.channel === "WHATSAPP" ? maskPhone(conv.channelUser.externalUserId) : `${conv.channelUser.externalUserId.slice(0, 6)}…`}
                </dd>
                <dt>Conversations</dt>
                <dd className="num">{c._count.conversations}</dd>
                <dt>Orders (chat)</dt>
                <dd className="num">{c._count.orders}</dd>
                <dt>Tags</dt>
                <dd>{c.tags.length ? <span className="tags">{c.tags.map((t) => <span key={t} className="tag">{t}</span>)}</span> : "—"}</dd>
              </dl>
            </div>
            <div className="card-footer">
              <Link href={`/admin/customers/${c.id}`} className="link small" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                Full profile <ArrowUpRight width={14} height={14} aria-hidden />
              </Link>
            </div>
          </div>

          <div className="card">
            <CardHeader icon={Headset} title="Handoffs" />
            <div className="card-body">
              {conv.handoffs.length === 0 && <EmptyState icon={Headset} title="No handoffs" compact />}
              {conv.handoffs.map((h) => (
                <div key={h.id} className="list-item">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <span className="strong small">{humanize(h.reason)}</span>
                      {h.resolvedAt ? <span className="pill tone-good">Resolved</span> : <span className="pill tone-critical">Open</span>}
                    </div>
                    {h.detail && <div className="small muted" style={{ marginTop: 2 }}>{h.detail}</div>}
                  </div>
                  <span className="tiny muted nowrap">{timeAgo(h.createdAt)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <CardHeader icon={FileText} title="Draft orders" />
            <div className="card-body">
              {conv.drafts.length === 0 && <EmptyState icon={FileText} title="No draft orders" compact />}
              {conv.drafts.map((d) => (
                <div key={d.id} className="list-item" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                  <div className="row">
                    <OrderStatusPill status={d.status} />
                    <span className="strong num">{money(d.total.toString())}</span>
                    <span className="spacer" />
                    <span className="tiny muted">{timeAgo(d.createdAt)}</span>
                  </div>
                  <pre style={{ margin: 0 }}>{((d.payload as { summaryLines?: string[] }).summaryLines ?? []).join("\n")}</pre>
                  {d.error && <div className="small error">{d.error}</div>}
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <CardHeader icon={ReceiptText} title="Recent orders" />
            <div className="card-body">
              {c.orders.length === 0 && <EmptyState icon={ReceiptText} title="No orders yet" compact />}
              {c.orders.map((o) => (
                <div key={o.id} className="list-item" style={{ alignItems: "center" }}>
                  <span className="strong">{o.shopifyOrderName ?? "Draft"}</span>
                  <OrderStatusPill status={o.status} />
                  <span className="spacer" />
                  <span className="num small">{money(o.total?.toString())}</span>
                  <span className="tiny muted nowrap">{timeAgo(o.createdAt)}</span>
                </div>
              ))}
            </div>
          </div>

          <details className="card collapse">
            <summary>
              <Wrench width={16} height={16} className="muted" aria-hidden />
              AI tool calls <span className="pill">{conv.toolCalls.length}</span>
              <ChevronRight width={16} height={16} className="chev" aria-hidden />
            </summary>
            <div className="card-body">
              {conv.toolCalls.length === 0 && <p className="small muted">The AI hasn&apos;t used any tools here.</p>}
              {conv.toolCalls.map((t) => (
                <div key={t.id} className="list-item" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                  <div className="row">
                    <span className="mono strong">{t.tool}</span>
                    <span className={`pill ${t.success ? "tone-good" : "tone-critical"}`}>{t.success ? "OK" : "Failed"}</span>
                    <span className="spacer" />
                    <span className="tiny muted">{t.durationMs}ms · {timeAgo(t.createdAt)}</span>
                  </div>
                  <pre>{JSON.stringify(t.input, null, 1)}</pre>
                  <pre>{JSON.stringify(t.output, null, 1)}</pre>
                </div>
              ))}
            </div>
          </details>
        </div>
      </div>
    </>
  );
}
