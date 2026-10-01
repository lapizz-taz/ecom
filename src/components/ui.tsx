import type { ReactNode } from "react";
import { Bot, CircleAlert, CircleCheck, FlaskConical, Headset, type LucideIcon } from "lucide-react";

/** Server-safe presentational helpers shared by every console page. */

export const STATUS_META: Record<string, { label: string; tone: string; icon: LucideIcon; hint: string }> = {
  AI_ACTIVE: { label: "AI handling", tone: "good", icon: Bot, hint: "The assistant is replying" },
  HUMAN_REQUIRED: { label: "Needs a human", tone: "critical", icon: CircleAlert, hint: "Waiting for your team" },
  HUMAN_ACTIVE: { label: "Human handling", tone: "warning", icon: Headset, hint: "A staff member took over" },
  RESOLVED: { label: "Resolved", tone: "neutral", icon: CircleCheck, hint: "Closed conversations" },
};

export const CHANNEL_LABEL: Record<string, string> = {
  INSTAGRAM: "Instagram",
  MESSENGER: "Messenger",
  WHATSAPP: "WhatsApp",
  TEST: "Test",
};

export function humanize(s: string) {
  const t = s.replace(/[_.-]+/g, " ").trim().toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function ChannelIcon({ channel, size = 14 }: { channel: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (channel) {
    case "INSTAGRAM":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="17.5" cy="6.5" r="0.6" fill="currentColor" />
        </svg>
      );
    case "MESSENGER":
      return (
        <svg {...common}>
          <path d="M12 3C7 3 3 6.7 3 11.3c0 2.5 1.2 4.7 3.1 6.2V21l3.3-1.8c.8.2 1.7.3 2.6.3 5 0 9-3.7 9-8.2S17 3 12 3Z" />
          <path d="m7.5 13.5 3-3.2 2.4 2.2 3.6-3.5" />
        </svg>
      );
    case "WHATSAPP":
      return (
        <svg {...common}>
          <path d="M7.9 20A9 9 0 1 0 4 16.1L3 21Z" />
          <path d="M9.2 8.6c-.3 2.6 2.2 5.7 5 6.1l1.3-1.3-1.7-1-1 .8c-.9-.4-1.8-1.3-2.2-2.2l.8-1-1-1.7Z" fill="currentColor" strokeWidth="1" />
        </svg>
      );
    default:
      return <FlaskConical width={size} height={size} aria-hidden />;
  }
}

export function ChannelPill({ channel, compact = false }: { channel: string; compact?: boolean }) {
  return (
    <span className={`pill ch-${channel}`} title={CHANNEL_LABEL[channel] ?? channel}>
      <ChannelIcon channel={channel} size={13} />
      {compact ? <span className="sr-only">{CHANNEL_LABEL[channel] ?? channel}</span> : CHANNEL_LABEL[channel] ?? channel}
    </span>
  );
}

export function StatusPill({ status, large = false }: { status: string; large?: boolean }) {
  const meta = STATUS_META[status];
  if (!meta) return <span className="pill">{humanize(status)}</span>;
  const Icon = meta.icon;
  return (
    <span className={`pill tone-${meta.tone}${large ? " lg" : ""}`}>
      <Icon aria-hidden />
      {meta.label}
    </span>
  );
}

/** Order / draft statuses coming from Shopify or the AI order flow. */
export function OrderStatusPill({ status }: { status: string }) {
  const s = status.toUpperCase();
  const tone = /FAIL|CANCEL|EXPIRED|REFUND/.test(s) ? "critical" : /AWAIT|PENDING|PROCESS|DRAFT|UNFULFILLED/.test(s) ? "warning" : /CONFIRM|FULFILLED|PAID|COMPLETE|DELIVERED|SENT/.test(s) ? "good" : "neutral";
  return <span className={`pill tone-${tone}`}>{humanize(status)}</span>;
}

const AVATAR_COLORS = ["#4f46e5", "#c11574", "#0e7090", "#b54708", "#067647", "#6941c6", "#c4320a", "#175cd3"];

export function initials(name: string | null | undefined) {
  const parts = (name ?? "").replace(/[@._-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function Avatar({ name, size }: { name: string | null | undefined; size?: "sm" | "lg" | "xl" }) {
  const seed = [...(name ?? "?")].reduce((a, c) => a + c.charCodeAt(0), 0);
  const color = AVATAR_COLORS[seed % AVATAR_COLORS.length];
  return (
    <span className={`avatar${size ? ` ${size}` : ""}`} style={{ ["--av" as string]: color }} aria-hidden>
      {initials(name)}
    </span>
  );
}

export function PageHeader({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-header">
      <div className="page-heading">
        <h1>{title}</h1>
        {description && <p className="page-desc">{description}</p>}
        {children}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, compact = false }: { icon: LucideIcon; title: string; children?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty${compact ? " compact" : ""}`}>
      <div className="empty-icon">
        <Icon width={20} height={20} aria-hidden />
      </div>
      <div className="empty-title">{title}</div>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

export function CardHeader({ icon: Icon, title, description, actions }: { icon?: LucideIcon; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="card-header">
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2 className="card-title">
          {Icon && <Icon width={17} height={17} aria-hidden />}
          {title}
        </h2>
        {description && <p className="card-desc">{description}</p>}
      </div>
      {actions}
    </div>
  );
}
