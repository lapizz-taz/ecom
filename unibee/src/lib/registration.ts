/**
 * Registration form: fields, options and validation rules.
 * Shared by the browser (inline validation) and the server (/api/register),
 * so the rules can never drift apart.
 */

export const GROUPS = ["Science", "Commerce", "Arts"] as const;
export const STUDY_LEVELS = ["Bachelor's", "Master's"] as const;
export const ENGLISH_TESTS = ["IELTS", "PTE", "Duolingo", "TOEFL", "Medium of Instruction (MOI)", "Not taken yet"] as const;
export const PLAN_OPTIONS = ["Yes", "No", "Not sure"] as const;

export const SCORED_TESTS: Record<string, { min: number; max: number; hint: string }> = {
  IELTS: { min: 0, max: 9, hint: "Overall band, e.g. 6.5" },
  PTE: { min: 10, max: 90, hint: "Overall score, e.g. 58" },
  Duolingo: { min: 10, max: 160, hint: "Overall score, e.g. 110" },
  TOEFL: { min: 0, max: 120, hint: "iBT total, e.g. 85" },
};

/** Passing-year options: this year back 20 years. */
export function yearOptions(now = new Date()): string[] {
  const y = now.getFullYear();
  return Array.from({ length: 21 }, (_, i) => String(y - i));
}

export type RegistrationValues = {
  // Step 1
  fullName: string;
  email: string;
  phone: string;
  sameWhatsapp: boolean;
  whatsapp: string;
  // Step 2
  sscGpa: string;
  sscYear: string;
  sscGroup: string;
  hscGpa: string;
  hscYear: string;
  hscGroup: string;
  hasBachelor: boolean;
  bachelorSubject: string;
  bachelorCgpa: string;
  bachelorYear: string;
  studyLevel: string;
  englishTest: string;
  englishScore: string;
  englishTestDate: string;
  moiDetails: string;
  planToTakeTest: string;
  moiIfEnglish: string;
  whyLithuania: string;
  // Step 3
  comments: string;
  university: string;
  consent: boolean;
};

export type FieldName = keyof RegistrationValues;
export type Errors = Partial<Record<FieldName, string>>;

export const emptyValues: RegistrationValues = {
  fullName: "",
  email: "",
  phone: "",
  sameWhatsapp: true,
  whatsapp: "",
  sscGpa: "",
  sscYear: "",
  sscGroup: "",
  hscGpa: "",
  hscYear: "",
  hscGroup: "",
  hasBachelor: false,
  bachelorSubject: "",
  bachelorCgpa: "",
  bachelorYear: "",
  studyLevel: "",
  englishTest: "",
  englishScore: "",
  englishTestDate: "",
  moiDetails: "",
  planToTakeTest: "",
  moiIfEnglish: "",
  whyLithuania: "",
  comments: "",
  university: "",
  consent: false,
};

export const STEP_FIELDS: FieldName[][] = [
  ["fullName", "email", "phone", "whatsapp"],
  [
    "sscGpa", "sscYear", "sscGroup", "hscGpa", "hscYear", "hscGroup",
    "bachelorSubject", "bachelorCgpa", "bachelorYear", "studyLevel",
    "englishTest", "englishScore", "englishTestDate", "moiDetails", "planToTakeTest", "moiIfEnglish",
    "whyLithuania",
  ],
  ["comments", "consent"],
];

export const WHY_MIN = 30;
export const TEXT_MAX = 2000;

/**
 * Normalises a Bangladeshi mobile number to 01XXXXXXXXX.
 * Accepts "01712345678", "1712345678", "+8801712345678", "8801712-345678", etc.
 */
export function normalizeBdPhone(input: string): string {
  let d = (input || "").replace(/\D/g, "");
  if (d.startsWith("880")) d = d.slice(3);
  if (d.length === 10 && d.startsWith("1")) d = "0" + d;
  return d;
}

export const isValidBdPhone = (input: string) => /^01[3-9]\d{8}$/.test(normalizeBdPhone(input));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

function gpa(v: string, label: string, min = 1, max = 5): string | undefined {
  const s = v.trim();
  if (!s) return `Please enter your ${label}.`;
  if (!DECIMAL_RE.test(s)) return `Use numbers only, e.g. ${max === 5 ? "4.50" : "3.25"}.`;
  const n = Number(s);
  if (n < min || n > max) return `${label} must be between ${min.toFixed(2)} and ${max.toFixed(2)}.`;
}

/** Returns an error message for one field, or undefined when it's valid. */
export function validateField(name: FieldName, v: RegistrationValues): string | undefined {
  switch (name) {
    case "fullName": {
      const s = v.fullName.trim();
      if (!s) return "Please enter your full name.";
      if (s.length < 3) return "Please enter your full name as on your certificates.";
      if (s.length > 100) return "Name is too long.";
      return;
    }
    case "email": {
      const s = v.email.trim();
      if (!s) return "Please enter your email address.";
      if (!EMAIL_RE.test(s) || s.length > 150) return "That email doesn't look right. Please check it (e.g. name@gmail.com).";
      return;
    }
    case "phone":
      if (!v.phone.trim()) return "Please enter your WhatsApp number.";
      if (!isValidBdPhone(v.phone)) return "Enter a valid Bangladeshi mobile number: 11 digits starting with 01 (e.g. 01712345678).";
      return;
    case "whatsapp":
      if (v.sameWhatsapp) return;
      if (!v.whatsapp.trim()) return "Please enter your WhatsApp number.";
      if (!isValidBdPhone(v.whatsapp)) return "Enter a valid Bangladeshi mobile number: 11 digits starting with 01.";
      return;

    case "sscGpa":
      return gpa(v.sscGpa, "SSC GPA");
    case "hscGpa":
      return gpa(v.hscGpa, "HSC GPA");
    case "sscYear":
      return v.sscYear ? undefined : "Please choose your SSC passing year.";
    case "hscYear":
      if (!v.hscYear) return "Please choose your HSC passing year.";
      if (v.sscYear && Number(v.hscYear) <= Number(v.sscYear)) return "HSC year should be after your SSC year.";
      return;
    case "sscGroup":
      return (GROUPS as readonly string[]).includes(v.sscGroup) ? undefined : "Please choose your SSC group.";
    case "hscGroup":
      return (GROUPS as readonly string[]).includes(v.hscGroup) ? undefined : "Please choose your HSC group.";

    case "bachelorSubject":
      if (!v.hasBachelor) return;
      if (!v.bachelorSubject.trim()) return "Please enter your bachelor's subject.";
      if (v.bachelorSubject.length > 120) return "Subject is too long.";
      return;
    case "bachelorCgpa":
      if (!v.hasBachelor) return;
      return gpa(v.bachelorCgpa, "CGPA", 1, 4);
    case "bachelorYear":
      if (!v.hasBachelor) return;
      if (!v.bachelorYear) return "Please choose your passing year.";
      if (v.hscYear && Number(v.bachelorYear) <= Number(v.hscYear)) return "Bachelor's year should be after your HSC year.";
      return;

    case "studyLevel":
      return (STUDY_LEVELS as readonly string[]).includes(v.studyLevel) ? undefined : "Please choose the level you want to study.";
    case "englishTest":
      return (ENGLISH_TESTS as readonly string[]).includes(v.englishTest) ? undefined : "Please choose your English test (or \"Not taken yet\").";
    case "englishScore": {
      const range = SCORED_TESTS[v.englishTest];
      if (!range) return;
      const s = v.englishScore.trim();
      if (!s) return `Please enter your ${v.englishTest} overall score.`;
      if (!/^\d+(\.\d)?$/.test(s)) return "Use numbers only, e.g. " + range.hint.split("e.g. ")[1] + ".";
      const n = Number(s);
      if (n < range.min || n > range.max) return `${v.englishTest} scores range from ${range.min} to ${range.max}.`;
      if (v.englishTest === "IELTS" && (n * 2) % 1 !== 0) return "IELTS bands go in steps of 0.5 (e.g. 6.0, 6.5).";
      return;
    }
    case "englishTestDate": {
      if (!SCORED_TESTS[v.englishTest] || !v.englishTestDate) return;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.englishTestDate)) return "Please choose a valid date.";
      return;
    }
    case "moiDetails":
      if (v.englishTest !== "Medium of Instruction (MOI)") return;
      if (!v.moiDetails.trim()) return "Please tell us about your Medium of Instruction (e.g. English Version school).";
      if (v.moiDetails.length > 300) return "Please keep this under 300 characters.";
      return;
    case "planToTakeTest":
      if (v.englishTest !== "Not taken yet") return;
      return (PLAN_OPTIONS as readonly string[]).includes(v.planToTakeTest) ? undefined : "Please choose an option.";
    case "moiIfEnglish":
      return v.moiIfEnglish.length > 300 ? "Please keep this under 300 characters." : undefined;
    case "whyLithuania": {
      const n = v.whyLithuania.trim().length;
      if (!n) return "Please tell us why you want to study in Lithuania.";
      if (n < WHY_MIN) return `Please write at least ${WHY_MIN} characters (${WHY_MIN - n} more to go).`;
      if (n > TEXT_MAX) return `Please keep this under ${TEXT_MAX} characters.`;
      return;
    }

    case "comments":
      return v.comments.length > TEXT_MAX ? `Please keep this under ${TEXT_MAX} characters.` : undefined;
    case "university":
      return v.university.length > 200 ? "Too long." : undefined;
    case "consent":
      return v.consent ? undefined : "Please tick this box so our team can contact you.";
    default:
      return;
  }
}

export function validateStep(step: number, v: RegistrationValues): Errors {
  const errors: Errors = {};
  for (const f of STEP_FIELDS[step] ?? []) {
    const e = validateField(f, v);
    if (e) errors[f] = e;
  }
  return errors;
}

export function validateAll(v: RegistrationValues): Errors {
  const errors: Errors = { ...validateStep(0, v), ...validateStep(1, v), ...validateStep(2, v) };
  const uni = validateField("university", v);
  if (uni) errors.university = uni;
  return errors;
}

/** Coerces untrusted JSON into RegistrationValues (unknown keys dropped, types forced). */
export function coerceValues(input: unknown): RegistrationValues {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out = { ...emptyValues } as Record<string, unknown>;
  for (const key of Object.keys(emptyValues) as FieldName[]) {
    const def = emptyValues[key];
    const val = src[key];
    if (typeof def === "boolean") out[key] = val === true;
    else out[key] = typeof val === "string" ? val.slice(0, TEXT_MAX + 100) : "";
  }
  return out as RegistrationValues;
}

/**
 * One flat row per registration. This exact column order is used for
 * Google Sheets, Supabase, the admin page and CSV export.
 */
export const COLUMNS = [
  ["created_at", "Submitted at"],
  ["full_name", "Full name"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["whatsapp", "WhatsApp"],
  ["study_level", "Study level"],
  ["ssc_gpa", "SSC GPA"],
  ["ssc_year", "SSC year"],
  ["ssc_group", "SSC group"],
  ["hsc_gpa", "HSC GPA"],
  ["hsc_year", "HSC year"],
  ["hsc_group", "HSC group"],
  ["bachelor_subject", "Bachelor subject"],
  ["bachelor_cgpa", "Bachelor CGPA"],
  ["bachelor_year", "Bachelor year"],
  ["english_test", "English test"],
  ["english_score", "English score"],
  ["english_test_date", "Test date"],
  ["moi_details", "MOI details"],
  ["plan_to_take_test", "Plans to take a test"],
  ["moi_if_english", "MOI (if English)"],
  ["why_lithuania", "Why Lithuania"],
  ["university", "Interested university"],
  ["comments", "Comments"],
  ["source", "Source"],
  ["id", "ID"],
] as const;

export type ColumnKey = (typeof COLUMNS)[number][0];
export type RegistrationRecord = Record<ColumnKey, string>;

const toIntl = (p: string) => "+88" + normalizeBdPhone(p);

export function toRecord(v: RegistrationValues, meta: { id: string; createdAt: string; source: string }): RegistrationRecord {
  const scored = Boolean(SCORED_TESTS[v.englishTest]);
  return {
    created_at: meta.createdAt,
    full_name: v.fullName.trim(),
    email: v.email.trim().toLowerCase(),
    phone: toIntl(v.phone),
    whatsapp: toIntl(v.sameWhatsapp ? v.phone : v.whatsapp),
    study_level: v.studyLevel,
    ssc_gpa: v.sscGpa.trim(),
    ssc_year: v.sscYear,
    ssc_group: v.sscGroup,
    hsc_gpa: v.hscGpa.trim(),
    hsc_year: v.hscYear,
    hsc_group: v.hscGroup,
    bachelor_subject: v.hasBachelor ? v.bachelorSubject.trim() : "",
    bachelor_cgpa: v.hasBachelor ? v.bachelorCgpa.trim() : "",
    bachelor_year: v.hasBachelor ? v.bachelorYear : "",
    english_test: v.englishTest,
    english_score: scored ? v.englishScore.trim() : "",
    english_test_date: scored ? v.englishTestDate : "",
    moi_details: v.englishTest === "Medium of Instruction (MOI)" ? v.moiDetails.trim() : "",
    plan_to_take_test: v.englishTest === "Not taken yet" ? v.planToTakeTest : "",
    moi_if_english: v.englishTest === "Not taken yet" ? v.moiIfEnglish.trim() : "",
    why_lithuania: v.whyLithuania.trim(),
    university: v.university.trim(),
    comments: v.comments.trim(),
    source: meta.source,
    id: meta.id,
  };
}
