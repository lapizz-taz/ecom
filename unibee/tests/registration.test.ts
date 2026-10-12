import { describe, expect, it } from "vitest";
import {
  coerceValues, emptyValues, isValidBdPhone, normalizeBdPhone, toRecord, validateAll, validateField, validateStep,
  type RegistrationValues,
} from "@/lib/registration";

const valid: RegistrationValues = {
  ...emptyValues,
  fullName: "Rahim Uddin",
  email: "rahim@gmail.com",
  phone: "01712345678",
  sscGpa: "5.00",
  sscYear: "2020",
  sscGroup: "Science",
  hscGpa: "4.83",
  hscYear: "2022",
  hscGroup: "Science",
  studyLevel: "Bachelor's",
  englishTest: "IELTS",
  englishScore: "6.5",
  whyLithuania: "Affordable tuition in the EU and strong computer science programs.",
  consent: true,
};

describe("Bangladeshi phone numbers", () => {
  it.each(["01712345678", "+8801712345678", "8801712-345678", "1712345678", "017 1234 5678"])("accepts %s", (p) => {
    expect(isValidBdPhone(p)).toBe(true);
    expect(normalizeBdPhone(p)).toBe("01712345678");
  });
  it.each(["0171234567", "02123456789", "01212345678", "abc", "", "017123456789"])("rejects %s", (p) => {
    expect(isValidBdPhone(p)).toBe(false);
  });
});

describe("validation", () => {
  it("passes a complete registration", () => {
    expect(validateAll(valid)).toEqual({});
  });

  it("requires a separate WhatsApp number only when the box is unticked", () => {
    expect(validateField("whatsapp", { ...valid, sameWhatsapp: true, whatsapp: "" })).toBeUndefined();
    expect(validateField("whatsapp", { ...valid, sameWhatsapp: false, whatsapp: "" })).toBeTruthy();
    expect(validateField("whatsapp", { ...valid, sameWhatsapp: false, whatsapp: "01812345678" })).toBeUndefined();
  });

  it("checks GPA range and format", () => {
    expect(validateField("sscGpa", { ...valid, sscGpa: "5.01" })).toMatch(/between/);
    expect(validateField("sscGpa", { ...valid, sscGpa: "0.5" })).toMatch(/between/);
    expect(validateField("sscGpa", { ...valid, sscGpa: "4.5a" })).toMatch(/numbers/);
    expect(validateField("hscGpa", { ...valid, hscGpa: "3.5" })).toBeUndefined();
  });

  it("requires HSC year after SSC year", () => {
    expect(validateField("hscYear", { ...valid, sscYear: "2022", hscYear: "2022" })).toBeTruthy();
  });

  it("applies English test conditional rules", () => {
    expect(validateField("englishScore", { ...valid, englishScore: "" })).toBeTruthy();
    expect(validateField("englishScore", { ...valid, englishScore: "6.3" })).toMatch(/0\.5/);
    expect(validateField("englishScore", { ...valid, englishTest: "PTE", englishScore: "95" })).toMatch(/10 to 90/);
    expect(validateField("englishScore", { ...valid, englishTest: "Duolingo", englishScore: "115" })).toBeUndefined();

    const moi = { ...valid, englishTest: "Medium of Instruction (MOI)", englishScore: "" };
    expect(validateField("englishScore", moi)).toBeUndefined();
    expect(validateField("moiDetails", moi)).toBeTruthy();
    expect(validateField("moiDetails", { ...moi, moiDetails: "English Version" })).toBeUndefined();

    const none = { ...valid, englishTest: "Not taken yet", englishScore: "" };
    expect(validateField("planToTakeTest", none)).toBeTruthy();
    expect(validateField("planToTakeTest", { ...none, planToTakeTest: "Not sure" })).toBeUndefined();
  });

  it("requires at least 30 characters for Why Lithuania", () => {
    expect(validateField("whyLithuania", { ...valid, whyLithuania: "Cheap tuition" })).toMatch(/more to go/);
  });

  it("validates bachelor's fields only when ticked", () => {
    expect(validateStep(1, { ...valid, hasBachelor: false })).toEqual({});
    const errs = validateStep(1, { ...valid, hasBachelor: true });
    expect(Object.keys(errs).sort()).toEqual(["bachelorCgpa", "bachelorSubject", "bachelorYear"]);
    expect(validateField("bachelorCgpa", { ...valid, hasBachelor: true, bachelorCgpa: "4.5" })).toMatch(/between/);
  });

  it("requires consent", () => {
    expect(validateStep(2, { ...valid, consent: false })).toHaveProperty("consent");
  });
});

describe("coerceValues / toRecord", () => {
  it("drops unknown keys and forces types", () => {
    const v = coerceValues({ fullName: "A", consent: "yes", hacker: "x", sameWhatsapp: true });
    expect(v.consent).toBe(false);
    expect(v.sameWhatsapp).toBe(true);
    expect("hacker" in v).toBe(false);
  });

  it("builds a flat record with international numbers and only relevant fields", () => {
    const r = toRecord({ ...valid, moiDetails: "ignored" }, { id: "1", createdAt: "2026-01-01T00:00:00Z", source: "direct" });
    expect(r.phone).toBe("+8801712345678");
    expect(r.whatsapp).toBe("+8801712345678");
    expect(r.moi_details).toBe("");
    expect(r.english_score).toBe("6.5");
  });
});
