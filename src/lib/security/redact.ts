/**
 * Redaction helpers — used by the logger and before storing / forwarding customer text.
 * Goal: never persist or log secrets, OTPs, PINs, passwords or card numbers.
 */

const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|authorization|api[-_]?key|access[-_]?key|otp|pin|cvv|cvc|card|signature|cookie|session)/i;

export function redactObject<T>(value: T, depth = 0): T {
  if (depth > 8) return "[depth]" as unknown as T;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1)) as unknown as T;
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) } as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[REDACTED]" : redactObject(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

export function redactString(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    .replace(/(access_token|client_secret|appsecret_proof|hub\.verify_token)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/\bshp(at|ss|ca|pa)_[A-Za-z0-9]+/g, "shp$1_[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_\-]{10,}/g, "sk-[REDACTED]")
    .replace(/\bEAA[A-Za-z0-9]{20,}/g, "EAA[REDACTED]");
}

/** Mask phone numbers for logs / analytics: 01712345678 -> 017******78 */
export function maskPhone(phone?: string | null): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, "");
  if (d.length < 6) return "***";
  return d.slice(0, 3) + "*".repeat(Math.max(0, d.length - 5)) + d.slice(-2);
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export type SensitiveKind = "otp" | "pin" | "password" | "card_number" | "cvv";

export interface SensitiveScan {
  found: boolean;
  kinds: SensitiveKind[];
  redacted: string;
}

const OTP_WORDS = "(?:otp|o\\.t\\.p|one[\\s-]?time[\\s-]?(?:password|code|pin)|verification code|verify code|ভেরিফিকেশন কোড|ওটিপি)";
const PIN_WORDS = "(?:pin|পিন|mpin|m-pin)";
const PASS_WORDS = "(?:password|passcode|pass word|pasword|পাসওয়ার্ড|পাসওয়ার্ড)";

/**
 * Detects credentials a customer may paste into chat (OTP, PIN, password, card number, CVV)
 * and returns a redacted copy of the text. Bangladeshi phone numbers (01XXXXXXXXX / +8801...)
 * and short order numbers are intentionally NOT treated as sensitive.
 */
export function scanSensitive(text: string): SensitiveScan {
  const kinds = new Set<SensitiveKind>();
  let redacted = text;

  // OTP / verification code followed by digits: "otp 123456", "my OTP is 4821", "code: 55 21 90"
  const otpRe = new RegExp(`${OTP_WORDS}[^0-9\\n]{0,20}((?:\\d[\\s-]?){4,8})`, "gi");
  redacted = redacted.replace(otpRe, (m, digits: string) => {
    kinds.add("otp");
    return m.replace(digits, "[REDACTED]");
  });
  // digits followed by "is my otp"
  const otpAfterRe = new RegExp(`\\b(\\d{4,8})\\b[^\\n]{0,15}${OTP_WORDS}`, "gi");
  redacted = redacted.replace(otpAfterRe, (m, digits: string) => {
    kinds.add("otp");
    return m.replace(digits, "[REDACTED]");
  });

  const pinRe = new RegExp(`\\b${PIN_WORDS}\\b[^0-9\\n]{0,15}(\\d{4,6})`, "gi");
  redacted = redacted.replace(pinRe, (m, digits: string) => {
    kinds.add("pin");
    return m.replace(digits, "[REDACTED]");
  });

  const passRe = new RegExp(`${PASS_WORDS}\\s*(?:is|hocche|holo|:|=)\\s*(\\S{3,})`, "gi");
  redacted = redacted.replace(passRe, (m, secret: string) => {
    kinds.add("password");
    return m.replace(secret, "[REDACTED]");
  });

  const cvvRe = /\b(cvv|cvc|cvv2)\b[^0-9\n]{0,10}(\d{3,4})/gi;
  redacted = redacted.replace(cvvRe, (m, _w, digits: string) => {
    kinds.add("cvv");
    return m.replace(digits, "[REDACTED]");
  });

  // Card numbers: 13–19 digits (spaces/dashes allowed) passing Luhn, excluding BD phone numbers.
  const cardRe = /\b(?:\d[ -]?){12,18}\d\b/g;
  redacted = redacted.replace(cardRe, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return m;
    if (/^(?:880)?01[3-9]\d{8}$/.test(digits)) return m; // phone number
    if (!luhnValid(digits)) return m;
    kinds.add("card_number");
    return "[REDACTED CARD]";
  });

  return { found: kinds.size > 0, kinds: [...kinds], redacted };
}
