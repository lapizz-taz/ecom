export type Lang = "en" | "bn" | "banglish";

// Common romanized-Bangla (Banglish) tokens used in shopping chats.
const BANGLISH_WORDS = new Set(
  (
    "vai bhai bhaiya apu apa vaiya koto dam daam ache ase achhe nai nei den dao diben dibo korbo korte korben kore koren korsi korechi " +
    "ki kivabe kemne keno kobe kothay kokhon ta ti gula gulo hobe hbe hoy hoise hoyeche lagbe chai chaisi chacchi pabo paabo pabe " +
    "amar amake ami apnar apni apnader tumi tomar amra ekta ekhon akhon ajke kal kalke thik ache accha acha ok vai " +
    "delivery charge taka tk jabe jaabe pathan pathaben pathiye dhakar dhakay dhaka baire bairer vitore " +
    "shathe sathe sate manush kotha bolbo bolen bolo please plz arekta aro onek beshi kom komano komiye " +
    "hoyni asheni ashe nai payni pai pelam pai nai ferot change bodlano bodle mal product ta order ta " +
    "confirm koren korun thakbe thakle naki ki na hya ha haa ji jii accha"
  ).split(/\s+/)
);

/** Very fast heuristic language detector for English / Bangla script / Banglish. */
export function detectLanguage(text: string): Lang {
  const t = text.trim();
  if (!t) return "en";
  const bnChars = (t.match(/[ঀ-৿]/g) || []).length;
  const latinChars = (t.match(/[A-Za-z]/g) || []).length;
  if (bnChars > 0 && bnChars >= latinChars * 0.5) return "bn";
  const words = t.toLowerCase().match(/[a-z]+/g) || [];
  if (words.length === 0) return bnChars > 0 ? "bn" : "en";
  const hits = words.filter((w) => BANGLISH_WORDS.has(w)).length;
  // "delivery", "charge", "order", "product", "ok", "please", "confirm", "change" are shared with English.
  const english = new Set(["delivery", "charge", "order", "product", "ok", "please", "confirm", "change", "plz", "dhaka"]);
  const strongHits = words.filter((w) => BANGLISH_WORDS.has(w) && !english.has(w)).length;
  if (strongHits >= 1 && (hits / words.length >= 0.2 || strongHits >= 2)) return "banglish";
  if (strongHits >= 1 && words.length <= 3) return "banglish";
  return "en";
}

export function languageLabel(lang: Lang): string {
  return lang === "bn" ? "Bangla (Bengali script)" : lang === "banglish" ? "Banglish (romanized Bangla, casual)" : "English";
}
