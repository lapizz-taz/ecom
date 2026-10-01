import Link from "next/link";
import { Bot, CircleAlert, Headset, Inbox, MessageSquare, Package, ShieldCheck, ShoppingBag, Tags, Timer, TrendingUp, UserRound, type LucideIcon } from "lucide-react";
import { getDashboardStats } from "@/lib/analytics";
import { CardHeader, ChannelPill, EmptyState, PageHeader, humanize } from "@/components/ui";

export const dynamic = "force-dynamic";

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

function BarList({ rows, unit, empty }: { rows: { label: string; value: number }[]; unit: string; empty: string }) {
  if (rows.length === 0) return <EmptyState icon={Inbox} title={empty} compact />;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <div className="bar-list">
      {rows.map((r) => (
        <div key={r.label} className="bar-row" title={`${r.label}: ${r.value} ${unit} (${total ? Math.round((r.value / total) * 100) : 0}%)`}>
          <span className="bar-label truncate">{r.label}</span>
          <span className="bar-value">{r.value.toLocaleString("en-US")}</span>
          <div className="bar-track" aria-hidden>
            <div className="bar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Kpi({ icon: Icon, tone, label, value, note }: { icon: LucideIcon; tone: string; label: string; value: string | number; note?: string }) {
  return (
    <div className="stat">
      <div className="stat-top">
        <span className={`stat-icon tone-${tone}`}><Icon aria-hidden /></span>
        <span className="stat-label">{label}</span>
      </div>
      <div className="stat-value num">{typeof value === "number" ? value.toLocaleString("en-US") : value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const days = Math.min(Math.max(Number((await searchParams).days) || 30, 1), 365);
  const s = await getDashboardStats(days);
  const replies = s.aiResponses + s.humanMessages;
  const aiShare = replies ? s.aiResponses / replies : 0;
  const maxConv = Math.max(...s.channelPerformance.map((c) => c.conversations), 1);

  return (
    <>
      <PageHeader
        title="Analytics"
        description={`How the assistant performed over the last ${days} days.`}
        actions={
          <div className="segmented" aria-label="Time range">
            {[7, 30, 90].map((d) => (
              <Link key={d} href={`/admin/analytics?days=${d}`} className={d === days ? "on" : ""}>
                {d} days
              </Link>
            ))}
          </div>
        }
      />

      <div className="stat-grid">
        <Kpi icon={MessageSquare} tone="accent" label="Conversations" value={s.conversations} note={`${s.messagesReceived.toLocaleString("en-US")} messages received`} />
        <Kpi icon={ShoppingBag} tone="good" label="Orders generated" value={s.ordersGenerated} note={`${pct(s.conversionRate)} conversion rate`} />
        <Kpi icon={Bot} tone="accent" label="Replies by AI" value={replies ? pct(aiShare) : "—"} note={`${s.aiResponses.toLocaleString("en-US")} AI · ${s.humanMessages.toLocaleString("en-US")} staff`} />
        <Kpi icon={Timer} tone="neutral" label="Avg AI response" value={s.avgResponseMs === null ? "—" : `${(s.avgResponseMs / 1000).toFixed(1)}s`} note="From message to reply" />
      </div>
      <div className="stat-grid">
        <Kpi icon={Bot} tone="neutral" label="AI responses" value={s.aiResponses} />
        <Kpi icon={Headset} tone="warning" label="Human handoffs" value={s.handoffs} />
        <Kpi icon={UserRound} tone="neutral" label="Staff messages" value={s.humanMessages} />
        <Kpi icon={CircleAlert} tone="critical" label="Failed queries" value={s.failedQueries} />
      </div>

      <div className="stack">
        <div className="card flush">
          <CardHeader icon={TrendingUp} title="Channel performance" description="Conversations, orders and handoffs by channel." />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Conversations</th>
                  <th className="num">Orders</th>
                  <th className="num">Handoffs</th>
                  <th className="num">Conversion</th>
                </tr>
              </thead>
              <tbody>
                {s.channelPerformance.map((c) => (
                  <tr key={c.channel}>
                    <td><ChannelPill channel={c.channel} /></td>
                    <td>
                      <div className="inline-bar" title={`${c.conversations} conversations`}>
                        <div className="bar-track" aria-hidden>
                          <div className="bar-fill" style={{ width: `${(c.conversations / maxConv) * 100}%` }} />
                        </div>
                        <span className="num strong" style={{ minWidth: 32, textAlign: "right" }}>{c.conversations}</span>
                      </div>
                    </td>
                    <td className="num">{c.orders}</td>
                    <td className="num">{c.handoffs}</td>
                    <td className="num strong">{pct(c.conversion)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="grid-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
          <div className="card">
            <CardHeader icon={Headset} title="Why chats were handed off" />
            <div className="card-body">
              <BarList
                unit="handoffs"
                empty="No handoffs in this period"
                rows={Object.entries(s.handoffsByReason).sort((a, b) => b[1] - a[1]).map(([r, n]) => ({ label: humanize(r), value: n }))}
              />
            </div>
          </div>
          <div className="card">
            <CardHeader icon={Package} title="Most requested products" />
            <div className="card-body">
              <BarList unit="requests" empty="No product requests yet" rows={s.topProducts.map((p) => ({ label: p.title, value: p.count }))} />
            </div>
          </div>
          <div className="card">
            <CardHeader icon={Tags} title="What customers ask about" />
            <div className="card-body">
              <BarList unit="messages" empty="No data yet" rows={s.topIntents.map((p) => ({ label: humanize(p.intent), value: p.count }))} />
            </div>
          </div>
        </div>

        <p className="small muted row" style={{ gap: 6 }}>
          <ShieldCheck width={15} height={15} aria-hidden />
          Analytics store only aggregate counters and topics — never message text or phone numbers. Test-chat traffic is excluded.
        </p>
      </div>
    </>
  );
}
