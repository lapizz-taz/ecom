import { getDashboardStats } from "@/lib/analytics";

export const dynamic = "force-dynamic";

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const days = Math.min(Math.max(Number((await searchParams).days) || 30, 1), 365);
  const s = await getDashboardStats(days);
  const tiles: [string, string | number][] = [
    ["Conversations", s.conversations],
    ["Messages received", s.messagesReceived],
    ["AI responses", s.aiResponses],
    ["Human messages", s.humanMessages],
    ["Human handoffs", s.handoffs],
    ["Orders generated", s.ordersGenerated],
    ["Conversion rate", pct(s.conversionRate)],
    ["Failed queries", s.failedQueries],
    ["Avg AI response", s.avgResponseMs === null ? "—" : `${(s.avgResponseMs / 1000).toFixed(1)}s`],
  ];
  return (
    <>
      <h1>Analytics — last {days} days</h1>
      <div className="filters">
        {[7, 30, 90].map((d) => (
          <a key={d} href={`/admin/analytics?days=${d}`} className={d === days ? "on" : ""}>{d} days</a>
        ))}
      </div>
      <div className="stats">
        {tiles.map(([l, v]) => (
          <div key={l} className="stat"><div className="v">{v}</div><div className="l">{l}</div></div>
        ))}
      </div>
      <div className="grid grid-2">
        <div className="card">
          <h3>Channel performance</h3>
          <table>
            <thead><tr><th>Channel</th><th>Conversations</th><th>Orders</th><th>Handoffs</th><th>Conversion</th></tr></thead>
            <tbody>
              {s.channelPerformance.map((c) => (
                <tr key={c.channel}><td><span className={`badge ${c.channel}`}>{c.channel.toLowerCase()}</span></td><td>{c.conversations}</td><td>{c.orders}</td><td>{c.handoffs}</td><td>{pct(c.conversion)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3>Handoff reasons</h3>
          <table><tbody>
            {Object.entries(s.handoffsByReason).sort((a, b) => b[1] - a[1]).map(([r, n]) => <tr key={r}><td>{r.replace(/_/g, " ")}</td><td>{n}</td></tr>)}
            {Object.keys(s.handoffsByReason).length === 0 && <tr><td className="muted">No handoffs</td></tr>}
          </tbody></table>
        </div>
        <div className="card">
          <h3>Most requested products</h3>
          <table><tbody>
            {s.topProducts.map((p) => <tr key={p.title}><td>{p.title}</td><td>{p.count}</td></tr>)}
            {s.topProducts.length === 0 && <tr><td className="muted">No data yet</td></tr>}
          </tbody></table>
        </div>
        <div className="card">
          <h3>Most common questions (by topic)</h3>
          <table><tbody>
            {s.topIntents.map((p) => <tr key={p.intent}><td>{p.intent.replace(/_/g, " ")}</td><td>{p.count}</td></tr>)}
            {s.topIntents.length === 0 && <tr><td className="muted">No data yet</td></tr>}
          </tbody></table>
        </div>
      </div>
      <p className="small muted">Analytics store only aggregate counters and topics — never message text or phone numbers. Test-chat traffic is excluded.</p>
    </>
  );
}
