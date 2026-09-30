/**
 * Post-generation grounding checks — the last line of defence against hallucination.
 * If the model's reply contains a price, percentage, delivery time or order confirmation
 * that is not backed by tool results / configured business data, the reply is blocked
 * and the conversation is handed to a human instead.
 */

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
export function toLatinDigits(s: string): string {
  return s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

function num(s: string): number {
  return Number(s.replace(/,/g, ""));
}

/** Every number that appears anywhere in the grounding sources. */
export function collectNumbers(sources: unknown[]): Set<number> {
  const out = new Set<number>();
  const visit = (v: unknown) => {
    if (v === null || v === undefined) return;
    if (typeof v === "number" && Number.isFinite(v)) out.add(Math.round(v * 100) / 100);
    else if (typeof v === "string") {
      for (const m of toLatinDigits(v).matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(num(m[0]));
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === "object") Object.values(v as Record<string, unknown>).forEach(visit);
  };
  sources.forEach(visit);
  return out;
}

/** Money amounts mentioned in a reply: ৳799, 799 tk, Tk 80, 120 taka, ৮০ টাকা, BDT 879 */
export function extractMoney(text: string): number[] {
  const t = toLatinDigits(text);
  const amounts: number[] = [];
  const patterns = [
    /(?:৳|tk\.?|bdt|taka)\s*(\d[\d,]*(?:\.\d+)?)/gi,
    /(\d[\d,]*(?:\.\d+)?)\s*(?:৳|\/-|tk\b|taka\b|bdt\b|টাকা)/gi,
  ];
  for (const re of patterns) for (const m of t.matchAll(re)) amounts.push(num(m[1]!));
  return amounts;
}

export function extractPercentages(text: string): number[] {
  return [...toLatinDigits(text).matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
}

/** "2-3 days", "within 48 hours", "3 din", "২-৩ দিনের মধ্যে", "5 working days" */
export function extractDurations(text: string): number[] {
  const t = toLatinDigits(text);
  const out: number[] = [];
  const re = /(\d+)(?:\s*(?:-|–|to|theke|থেকে)\s*(\d+))?\s*(?:working\s+|business\s+)?(days?|din|দিন|hours?|hrs?|ghonta|ঘণ্টা|weeks?|soptaho|সপ্তাহ)/gi;
  for (const m of t.matchAll(re)) {
    out.push(Number(m[1]));
    if (m[2]) out.push(Number(m[2]));
  }
  return out;
}

const CONFIRMED_CLAIM_RE =
  /(order\s+(is\s+|has\s+been\s+|was\s+)?(confirmed|placed|successful|created|booked)|(confirmed|placed)\s+your\s+order|order\s+confirm\s*(hoye|hoyeche|hoise|hoyse|kora hoyeche|kore diyechi|kore dilam|korlam|done)|order\s+(done|complete)|অর্ডার(টি|টা)?\s*(কনফার্ম|নিশ্চিত|সম্পন্ন)\s*(হয়েছে|করা হয়েছে|হয়ে গেছে))/i;

export interface ValidationInput {
  reply: string;
  groundingSources: unknown[];
  customerText: string;
  orderConfirmedThisTurn: boolean;
}

export interface ValidationResult {
  ok: boolean;
  issues: string[];
}

export function validateReply(input: ValidationInput): ValidationResult {
  const issues: string[] = [];
  const reply = input.reply.trim();
  if (!reply) return { ok: false, issues: ["empty_reply"] };

  // Money & percentages must come from tool/config data — never from what the customer claims
  // ("is it 500 tk?" must not ground "yes, ৳500"). Customer numbers may only ground echoed durations.
  const grounded = collectNumbers(input.groundingSources);
  const groundedWithCustomer = collectNumbers([...input.groundingSources, input.customerText]);
  // Allow quantities x prices (qty 1..10) and sums of two grounded amounts (item + delivery).
  const base = [...grounded].filter((n) => n > 0 && n < 1_000_000);
  const derived = new Set<number>(base);
  for (const a of base) for (let q = 2; q <= 10; q++) derived.add(Math.round(a * q * 100) / 100);
  const derivedList = [...derived];
  if (derivedList.length < 400) {
    for (let i = 0; i < derivedList.length; i++)
      for (let j = i; j < derivedList.length; j++) derived.add(Math.round((derivedList[i]! + derivedList[j]!) * 100) / 100);
  }

  for (const amount of extractMoney(reply)) {
    if (!derived.has(amount)) issues.push(`ungrounded_amount:${amount}`);
  }
  for (const pct of extractPercentages(reply)) {
    if (!grounded.has(pct)) issues.push(`ungrounded_percentage:${pct}`);
  }
  for (const d of extractDurations(reply)) {
    if (!groundedWithCustomer.has(d)) issues.push(`ungrounded_duration:${d}`);
  }
  if (CONFIRMED_CLAIM_RE.test(reply) && !input.orderConfirmedThisTurn) {
    issues.push("unverified_order_confirmation_claim");
  }
  return { ok: issues.length === 0, issues };
}

/** Channel-safe cleanup: no markdown syntax, no internal IDs. */
export function sanitizeReply(text: string): string {
  return text
    .replace(/gid:\/\/shopify\/[A-Za-z]+\/[\w-]+/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1: $2")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
