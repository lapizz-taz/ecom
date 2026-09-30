/**
 * Bangladesh phone helpers. Canonical form: 01XXXXXXXXX (11 digits).
 */
export function normalizeBdPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const bnDigits = "০১২৩৪৫৬৭৮৯";
  let s = input.replace(/[০-৯]/g, (d) => String(bnDigits.indexOf(d)));
  s = s.replace(/[^\d+]/g, "");
  s = s.replace(/^\+/, "");
  if (s.startsWith("880")) s = s.slice(3);
  if (s.startsWith("0088")) s = s.slice(4);
  if (s.length === 10 && s.startsWith("1")) s = "0" + s;
  return /^01[3-9]\d{8}$/.test(s) ? s : null;
}

export function isValidBdPhone(input: string | null | undefined): boolean {
  return normalizeBdPhone(input) !== null;
}

/** Compare two phone numbers loosely (last 10 digits) — for matching Shopify records. */
export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeBdPhone(a) ?? a.replace(/\D/g, "");
  const nb = normalizeBdPhone(b) ?? b.replace(/\D/g, "");
  if (na.length < 8 || nb.length < 8) return false;
  return na.slice(-10) === nb.slice(-10);
}

/** WhatsApp sends numbers as 8801XXXXXXXXX. */
export function toWhatsAppNumber(phone: string): string {
  const n = normalizeBdPhone(phone);
  return n ? "88" + n : phone.replace(/\D/g, "");
}
