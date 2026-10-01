"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight, Bell, Bot, BookOpen, Building2, ChevronRight, CircleAlert, CircleCheck, CircleDashed, FlaskConical, Headset, Languages, LoaderCircle,
  MessageSquareText, MessagesSquare, Package, ReceiptText, Route, ScrollText, Send, ShoppingCart, Tag, Truck, UserRoundCheck, type LucideIcon,
} from "lucide-react";
import { ChannelIcon } from "@/components/ui";

type Health = "ok" | "problem" | "off";

interface AiSettings {
  enabled: boolean;
  autoReply: boolean;
  allowOrderCreation: boolean;
  orderCreationMode: "complete" | "draft";
  languageMode: string;
  handoff: {
    pauseAiOnHandoff: boolean;
    onAnger: boolean;
    onRefundRequest: boolean;
    onDiscountRequest: boolean;
    onCancelRequest: boolean;
    onPaymentProblem: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface AgentOverview {
  isAdmin: boolean;
  ai: AiSettings;
  health: Record<"openai" | "shopify" | "meta" | "instagram" | "whatsapp" | "orders" | "notifications", Health>;
  stats: { aiReplies: number; orders: number; handoffs: number; waiting: number };
  teach: { id: string; title: string; status: string; detail: string; done: boolean; href: string }[];
  orders: { destination: "shopify" | "platform" | "both"; undelivered: number; paymentMethods: string[]; zones: number };
  alerts: { email: string | null; webhook: boolean };
}

const TEACH_ICON: Record<string, LucideIcon> = {
  business: Building2,
  policies: ScrollText,
  faq: MessageSquareText,
  delivery: Truck,
  language: Languages,
  voice: Bot,
  promotions: Tag,
  products: Package,
};

const DESTINATION: Record<AgentOverview["orders"]["destination"], string> = {
  shopify: "Shopify",
  platform: "Your order platform",
  both: "Shopify and your order platform",
};

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <label className="switch switch-only" title={disabled ? "Only admins can change this" : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span className="track" />
    </label>
  );
}

function ControlRow({ icon: Icon, title, hint, children }: { icon: LucideIcon; title: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="control-row">
      <span className="control-icon"><Icon width={17} height={17} aria-hidden /></span>
      <div className="control-text">
        <div className="strong">{title}</div>
        <div className="small muted">{hint}</div>
      </div>
      <div className="control-action">{children}</div>
    </div>
  );
}

function StepHeading({ n, title, description, aside }: { n: number; title: string; description: string; aside?: ReactNode }) {
  return (
    <div className="step-heading">
      <span className="step-n" aria-hidden>{n}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2>{title}</h2>
        <p className="small muted">{description}</p>
      </div>
      {aside}
    </div>
  );
}

const CHANNELS: { key: "meta" | "instagram" | "whatsapp"; channel: "MESSENGER" | "INSTAGRAM" | "WHATSAPP"; label: string; anchor: string }[] = [
  { key: "meta", channel: "MESSENGER", label: "Messenger", anchor: "messenger" },
  { key: "instagram", channel: "INSTAGRAM", label: "Instagram", anchor: "instagram" },
  { key: "whatsapp", channel: "WHATSAPP", label: "WhatsApp", anchor: "whatsapp" },
];

export function AgentHub({ overview }: { overview: AgentOverview }) {
  const router = useRouter();
  const [ai, setAi] = useState<AiSettings>(overview.ai);
  const [saving, setSaving] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const { health, stats, teach, isAdmin } = overview;

  async function save(field: string, next: AiSettings) {
    const before = ai;
    setAi(next);
    setSaving(field);
    setFeedback(null);
    const res = await fetch("/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "ai", value: next }) });
    const j = (await res.json().catch(() => ({}))) as { error?: string; details?: string[] };
    setSaving(null);
    if (!res.ok) {
      setAi(before);
      setFeedback({ ok: false, text: j.details?.join("; ") ?? j.error ?? "Couldn't save" });
      return;
    }
    setFeedback({ ok: true, text: "Saved — the agent uses this from the next message." });
    router.refresh();
  }
  const set = (field: string, patch: Partial<AiSettings>) => save(field, { ...ai, ...patch });
  const setHandoff = (field: string, patch: Partial<AiSettings["handoff"]>) => save(field, { ...ai, handoff: { ...ai.handoff, ...patch } });

  const channelsOk = CHANNELS.filter((c) => health[c.key] === "ok").length;
  const status: { tone: string; icon: ReactNode; label: string; detail: ReactNode } = !ai.enabled
    ? { tone: "tone-neutral", icon: <CircleDashed aria-hidden />, label: "Agent off", detail: "Every new message goes to your team's inbox." }
    : !ai.autoReply
      ? { tone: "tone-warning", icon: <Headset aria-hidden />, label: "Replies paused", detail: "The agent is on, but new messages go to your team instead of being answered." }
      : health.openai !== "ok"
        ? {
            tone: "tone-critical",
            icon: <CircleAlert aria-hidden />,
            label: "Can't reply yet",
            detail: <>OpenAI isn&apos;t connected, so the agent can&apos;t write replies. {isAdmin && <Link className="link" href="/admin/integrations#openai">Connect OpenAI</Link>}</>,
          }
        : channelsOk === 0
          ? {
              tone: "tone-warning",
              icon: <CircleAlert aria-hidden />,
              label: "Ready — no channel connected",
              detail: <>Connect Messenger, Instagram or WhatsApp so customers can reach the agent. {isAdmin && <Link className="link" href="/admin/integrations">Open Integrations</Link>}</>,
            }
          : { tone: "tone-good", icon: <CircleCheck aria-hidden />, label: "Replying to customers", detail: `Answering on ${channelsOk} ${channelsOk === 1 ? "channel" : "channels"} around the clock.` };

  const teachDone = teach.filter((t) => t.done).length;
  const handoffRules: { key: keyof AiSettings["handoff"]; label: string }[] = [
    { key: "onAnger", label: "Customer is upset or angry" },
    { key: "onRefundRequest", label: "Asks for a refund" },
    { key: "onDiscountRequest", label: "Asks for a discount" },
    { key: "onCancelRequest", label: "Wants to cancel an order" },
    { key: "onPaymentProblem", label: "Has a payment problem" },
  ];

  return (
    <div className="stack agent-hub">
      {feedback && (
        <div className={`alert ${feedback.ok ? "alert-good" : "alert-critical"} toast-inline`} role="status">
          {feedback.ok ? <CircleCheck width={18} height={18} /> : <CircleAlert width={18} height={18} />}
          <div className="alert-title">{feedback.text}</div>
        </div>
      )}

      {/* ---------- the agent ---------- */}
      <section className="card agent-card">
        <div className="agent-top">
          <span className="agent-avatar" aria-hidden><Bot width={26} height={26} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <h2 className="agent-name">Your sales agent</h2>
              <span className={`pill lg ${status.tone}`}>{status.icon} {status.label}</span>
            </div>
            <p className="small text-2" style={{ margin: "4px 0 0" }}>{status.detail}</p>
          </div>
          <Link href="/test-chat" className="btn btn-primary">
            <FlaskConical width={15} height={15} aria-hidden /> Train with chat
          </Link>
        </div>

        <div className="agent-controls">
          <ControlRow icon={Bot} title="Agent on" hint="The master switch. When off, the agent never replies.">
            {saving === "enabled" && <LoaderCircle width={15} height={15} className="spin muted" />}
            <Switch checked={ai.enabled} disabled={!isAdmin || saving !== null} onChange={(v) => set("enabled", { enabled: v })} label="Agent on" />
          </ControlRow>
          <ControlRow icon={MessagesSquare} title="Reply to customers automatically" hint="When off, new messages wait in the Inbox for your team.">
            {saving === "autoReply" && <LoaderCircle width={15} height={15} className="spin muted" />}
            <Switch checked={ai.autoReply} disabled={!isAdmin || saving !== null || !ai.enabled} onChange={(v) => set("autoReply", { autoReply: v })} label="Reply to customers automatically" />
          </ControlRow>
        </div>

        <div className="agent-channels">
          {CHANNELS.map((c) => {
            const h = health[c.key];
            const body = (
              <>
                <ChannelIcon channel={c.channel} size={16} />
                <span className="strong small">{c.label}</span>
                <span className={`dot${h === "ok" ? " on" : h === "problem" ? " bad" : ""}`} aria-hidden />
                <span className="tiny muted">{h === "ok" ? "Connected" : h === "problem" ? "Problem" : "Not connected"}</span>
              </>
            );
            return isAdmin ? (
              <Link key={c.key} href={`/admin/integrations#${c.anchor}`} className="channel-chip">{body}</Link>
            ) : (
              <span key={c.key} className="channel-chip">{body}</span>
            );
          })}
        </div>

        <div className="agent-stats">
          <div><span className="num">{stats.aiReplies.toLocaleString("en-US")}</span><span className="tiny muted">replies sent this week</span></div>
          <div><span className="num">{stats.orders.toLocaleString("en-US")}</span><span className="tiny muted">orders taken this week</span></div>
          <div><span className="num">{stats.handoffs.toLocaleString("en-US")}</span><span className="tiny muted">chats handed to your team</span></div>
          <Link href="/admin?status=HUMAN_REQUIRED" className={stats.waiting ? "attention" : undefined}>
            <span className="num">{stats.waiting.toLocaleString("en-US")}</span>
            <span className="tiny muted">waiting for a human now</span>
          </Link>
        </div>
      </section>

      {/* ---------- 1. teach ---------- */}
      <section className="card">
        <StepHeading
          n={1}
          title="Teach your agent"
          description="It only states facts you've written here, and checks prices and stock live — it never makes things up."
          aside={<span className="pill">{teachDone} of {teach.length} done</span>}
        />
        <div className="meter" style={{ margin: "0 20px 6px" }} role="meter" aria-valuemin={0} aria-valuemax={teach.length} aria-valuenow={teachDone} aria-label="Training progress">
          <div className="meter-fill" style={{ width: `${(teachDone / teach.length) * 100}%` }} />
        </div>
        <div className="teach-list">
          {teach.map((t) => {
            const Icon = TEACH_ICON[t.id] ?? BookOpen;
            const inner = (
              <>
                <span className={`teach-icon${t.done ? " done" : ""}`}><Icon width={17} height={17} aria-hidden /></span>
                <span className="teach-text">
                  <span className="strong">{t.title}</span>
                  <span className="small muted truncate">{t.detail}</span>
                </span>
                <span className={`teach-status small${t.done ? " done" : ""}`}>
                  {t.done ? <CircleCheck width={14} height={14} aria-hidden /> : <CircleDashed width={14} height={14} aria-hidden />} {t.status}
                </span>
                {isAdmin && <ChevronRight width={16} height={16} className="muted" aria-hidden />}
              </>
            );
            return isAdmin ? (
              <Link key={t.id} href={t.href} className="teach-row">{inner}</Link>
            ) : (
              <div key={t.id} className="teach-row">{inner}</div>
            );
          })}
        </div>
      </section>

      {/* ---------- 2. orders ---------- */}
      <section className="card">
        <StepHeading n={2} title="Take orders" description="The agent collects the items, name, phone and address, shows a summary, and places the order only after the customer confirms." />
        <div className="agent-controls">
          <ControlRow icon={ShoppingCart} title="Take orders in chat" hint="When off, the agent collects the details and hands the order to your team.">
            {saving === "allowOrderCreation" && <LoaderCircle width={15} height={15} className="spin muted" />}
            <Switch checked={ai.allowOrderCreation} disabled={!isAdmin || saving !== null} onChange={(v) => set("allowOrderCreation", { allowOrderCreation: v })} label="Take orders in chat" />
          </ControlRow>
          <ControlRow icon={UserRoundCheck} title="After the customer confirms" hint={ai.orderCreationMode === "complete" ? "The order is placed right away and the customer gets an order number." : "Your team approves each order before it's placed; the customer is told it's received."}>
            <select
              value={ai.orderCreationMode}
              disabled={!isAdmin || saving !== null || !ai.allowOrderCreation}
              onChange={(e) => set("orderCreationMode", { orderCreationMode: e.target.value as AiSettings["orderCreationMode"] })}
              aria-label="After the customer confirms"
            >
              <option value="complete">Place the order right away</option>
              <option value="draft">Wait for my team to approve</option>
            </select>
          </ControlRow>
          <ControlRow
            icon={Route}
            title="Orders go to"
            hint={
              <>
                {DESTINATION[overview.orders.destination]}
                {overview.orders.undelivered > 0 && <span className="error"> · {overview.orders.undelivered} not delivered yet — <Link className="link" href="/admin/orders">see Orders</Link></span>}
              </>
            }
          >
            {isAdmin && (
              <Link href="/admin/integrations#orders" className="btn btn-sm">
                <Send width={14} height={14} aria-hidden /> {overview.orders.destination === "shopify" ? "Send to another platform" : "Change"}
              </Link>
            )}
          </ControlRow>
          <ControlRow icon={ReceiptText} title="Payment & delivery" hint={`${overview.orders.paymentMethods.join(", ") || "No payment method on"} · ${overview.orders.zones} delivery ${overview.orders.zones === 1 ? "zone" : "zones"}`}>
            {isAdmin && <Link href="/admin/settings#payment" className="btn btn-sm">Edit</Link>}
          </ControlRow>
        </div>
      </section>

      {/* ---------- 3. hand over ---------- */}
      <section className="card">
        <StepHeading n={3} title="Hand over to your team" description="The agent passes a chat to a person whenever it can't help — and always when the customer asks for one." />
        <div className="agent-controls">
          <ControlRow icon={Headset} title="Stay quiet once a person is needed" hint="The agent stops replying in that chat until your team hands it back.">
            {saving === "pause" && <LoaderCircle width={15} height={15} className="spin muted" />}
            <Switch checked={ai.handoff.pauseAiOnHandoff} disabled={!isAdmin || saving !== null} onChange={(v) => setHandoff("pause", { pauseAiOnHandoff: v })} label="Stay quiet once a person is needed" />
          </ControlRow>
        </div>
        <div className="rule-grid">
          <div className="section-title" style={{ gridColumn: "1 / -1", margin: 0 }}>Also hand over when the customer…</div>
          {handoffRules.map((r) => (
            <label key={r.key as string} className="rule">
              <input
                type="checkbox"
                checked={Boolean(ai.handoff[r.key])}
                disabled={!isAdmin || saving !== null}
                onChange={(e) => setHandoff(r.key as string, { [r.key]: e.target.checked })}
              />
              <span className="small">{r.label}</span>
              {saving === r.key && <LoaderCircle width={13} height={13} className="spin muted" />}
            </label>
          ))}
        </div>
        <div className="agent-controls">
          <ControlRow
            icon={Bell}
            title="Alerts"
            hint={
              overview.alerts.email || overview.alerts.webhook
                ? `Your team is alerted${overview.alerts.email ? ` by email (${overview.alerts.email})` : ""}${overview.alerts.email && overview.alerts.webhook ? " and" : ""}${overview.alerts.webhook ? " in Slack/Discord" : ""}.`
                : "No alerts set up — handed-over chats only show in the Inbox."
            }
          >
            {isAdmin && <Link href="/admin/settings#ai" className="btn btn-sm">Set up</Link>}
          </ControlRow>
        </div>
        <div className="card-footer">
          <Link href="/admin" className="btn btn-sm">
            <MessagesSquare width={14} height={14} aria-hidden /> Open the Inbox <ArrowRight width={14} height={14} aria-hidden />
          </Link>
          <span className="small muted">See every conversation, take over a chat, and hand it back to the agent.</span>
        </div>
      </section>
    </div>
  );
}
