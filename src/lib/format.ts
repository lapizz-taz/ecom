export function timeAgo(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const s = Math.round((Date.now() - date.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function dateTime(d: Date | string): string {
  return new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function timeOnly(d: Date | string): string {
  return new Date(d).toLocaleTimeString("en-GB", { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit" });
}

/** "Today", "Yesterday" or e.g. "Mon, 29 Sept" — in Dhaka time, for chat day separators. */
export function dayLabel(d: Date | string): string {
  const key = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
  const date = new Date(d);
  if (key(date) === key(new Date())) return "Today";
  if (key(date) === key(new Date(Date.now() - 86400_000))) return "Yesterday";
  return date.toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka", weekday: "short", day: "numeric", month: "short" });
}

export function money(n: number | string | null | undefined, symbol = "৳"): string {
  if (n === null || n === undefined) return "—";
  return `${symbol}${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
