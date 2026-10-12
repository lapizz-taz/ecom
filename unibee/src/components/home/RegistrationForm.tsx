"use client";

import {
  AlertCircle, ArrowLeft, ArrowRight, Check, CheckCircle2, Loader2, RotateCcw, X,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { SocialIcon } from "@/components/ui/SocialIcon";
import { Flag } from "@/components/ui/Flag";
import { useContent } from "@/components/content/ContentProvider";
import { whatsappUrl as buildWhatsappUrl } from "@/lib/content/helpers";
import { trackLead, trackWhatsAppClick } from "@/lib/analytics";
import { IS_PREVIEW } from "@/lib/links";
import {
  ENGLISH_TESTS, GROUPS, PLAN_OPTIONS, SCORED_TESTS, STEP_FIELDS, STUDY_LEVELS, TEXT_MAX, WHY_MIN,
  emptyValues, validateField, validateStep, yearOptions,
  type FieldName, type RegistrationValues,
} from "@/lib/registration";

const STORAGE_KEY = "unibee-registration-v1";
const SOURCE_KEY = "unibee-source";
const STEPS = ["Contact", "Academics", "Finish"];

type Status = "idle" | "submitting" | "success" | "error";

/* ───────────────────────── small field building blocks ───────────────────────── */

const fid = (name: string) => `reg-${name}`;

function describedBy(name: string, help?: boolean, error?: string) {
  return [help && `${fid(name)}-help`, error && `${fid(name)}-error`].filter(Boolean).join(" ") || undefined;
}

function FieldError({ name, error }: { name: string; error?: string }) {
  if (!error) return null;
  return (
    <p id={`${fid(name)}-error`} className="field-error">
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {error}
    </p>
  );
}

function Label({ name, children, required }: { name: string; children: ReactNode; required?: boolean }) {
  return (
    <label htmlFor={fid(name)} className="field-label">
      {children}
      {required && <span className="req" aria-hidden="true">*</span>}
    </label>
  );
}

function Fieldset({ legend, children, required, error, name }: { legend: ReactNode; children: ReactNode; required?: boolean; error?: string; name: string }) {
  return (
    <fieldset aria-describedby={error ? `${fid(name)}-error` : undefined}>
      <legend className="field-label">
        {legend}
        {required && <span className="req" aria-hidden="true">*</span>}
      </legend>
      {children}
      <FieldError name={name} error={error} />
    </fieldset>
  );
}

/* ───────────────────────── the form ───────────────────────── */

export function RegistrationForm() {
  const content = useContent();
  const { universities } = content;
  const whatsappUrl = (message?: string) => buildWhatsappUrl(content, message);
  const [values, setValues] = useState<RegistrationValues>(emptyValues);
  const [touched, setTouched] = useState<Set<FieldName>>(new Set());
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [serverError, setServerError] = useState("");
  const [restored, setRestored] = useState(false);
  const [submittedName, setSubmittedName] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const startedAt = useRef(0);
  const loaded = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const years = useMemo(() => yearOptions(), []);
  const formId = useId();

  // Restore saved progress, remember where the visitor came from, read ?university=
  useEffect(() => {
    startedAt.current = Date.now();
    let next = { ...emptyValues };
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved?.values) {
        next = { ...next, ...saved.values, consent: false };
        setStep(Math.min(Math.max(Number(saved.step) || 0, 0), 2));
        if (saved.values.fullName || saved.values.email || saved.values.phone) setRestored(true);
      }
    } catch {
      /* storage unavailable (private mode): carry on without it */
    }
    try {
      const params = new URLSearchParams(window.location.search);
      const slug = params.get("university");
      const uni = slug && universities.find((u) => u.slug === slug);
      if (uni) next = withUniversity(next, uni.name);
      if (!sessionStorage.getItem(SOURCE_KEY)) {
        const utm = ["utm_source", "utm_medium", "utm_campaign"].map((k) => params.get(k)).filter(Boolean).join(" / ");
        const ref = document.referrer && !document.referrer.includes(window.location.host) ? new URL(document.referrer).hostname : "";
        sessionStorage.setItem(SOURCE_KEY, [utm, ref].filter(Boolean).join(" · ") || "direct");
      }
    } catch {
      /* ignore */
    }
    setValues(next);
    loaded.current = true;
  }, []);

  // "Apply with UniBee" from a university pop-up
  useEffect(() => {
    const onApply = (e: Event) => {
      const name = (e as CustomEvent<{ university: string }>).detail?.university;
      if (!name) return;
      setValues((v) => withUniversity(v, name));
      if (status === "success") setStatus("idle");
    };
    window.addEventListener("unibee:apply", onApply);
    return () => window.removeEventListener("unibee:apply", onApply);
  }, [status]);

  // Save progress on this device (debounced)
  useEffect(() => {
    if (!loaded.current || status === "success") return;
    const t = window.setTimeout(() => {
      try {
        const { consent: _c, ...rest } = values;
        void _c;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ values: rest, step, savedAt: Date.now() }));
      } catch {
        /* ignore */
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [values, step, status]);

  // After a successful submit, bring the thank-you message into view and announce it.
  useEffect(() => {
    if (status !== "success") return;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    successRef.current?.focus({ preventScroll: true });
  }, [status]);

  const set = useCallback(<K extends FieldName>(name: K, value: RegistrationValues[K]) => {
    setValues((v) => ({ ...v, [name]: value }));
  }, []);
  const touch = useCallback((name: FieldName) => setTouched((t) => (t.has(name) ? t : new Set(t).add(name))), []);
  const err = (name: FieldName) => (touched.has(name) ? validateField(name, values) : undefined);

  /** Common props for text inputs: value, change, blur-validation, a11y wiring. */
  const bind = (name: FieldName, opts: { help?: boolean } = {}) => {
    const e = err(name);
    return {
      id: fid(name),
      name,
      value: values[name] as string,
      onChange: (ev: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => set(name, ev.target.value as never),
      onBlur: () => touch(name),
      "aria-invalid": e ? true : undefined,
      "aria-describedby": describedBy(name, opts.help, e),
    } as const;
  };

  const focusFirstError = (fields: FieldName[]) => {
    const first = fields.find((f) => validateField(f, values));
    if (!first) return;
    const el = document.getElementById(fid(first)) || document.querySelector<HTMLElement>(`[name="${first}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const goTo = (n: number) => {
    setStep(n);
    setServerError("");
    requestAnimationFrame(() => {
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      stepHeadingRef.current?.focus({ preventScroll: true });
    });
  };

  const next = () => {
    const errors = validateStep(step, values);
    if (Object.keys(errors).length) {
      setTouched((t) => new Set([...t, ...STEP_FIELDS[step]]));
      focusFirstError(STEP_FIELDS[step]);
      return;
    }
    goTo(step + 1);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step < 2) return next();
    if (status === "submitting") return; // no double submits

    // Validate everything (in case saved progress skipped a step)
    for (let s = 0; s < 3; s++) {
      if (Object.keys(validateStep(s, values)).length) {
        setTouched((t) => new Set([...t, ...STEP_FIELDS[s]]));
        if (s !== step) {
          goTo(s);
          window.setTimeout(() => focusFirstError(STEP_FIELDS[s]), 350);
        } else focusFirstError(STEP_FIELDS[s]);
        return;
      }
    }

    setStatus("submitting");
    setServerError("");
    try {
      let ok = false;
      if (IS_PREVIEW) {
        // Static preview: no server. Simulate a successful submission.
        await new Promise((r) => setTimeout(r, 900));
        ok = true;
      } else {
        const res = await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            values,
            website: honeypot,
            startedAt: startedAt.current,
            source: safeSession(SOURCE_KEY),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) ok = true;
        else if (res.status === 429) throw new Error("Too many attempts from this connection. Please wait a few minutes, or message us on WhatsApp.");
        else if (res.status === 422 && data.errors) {
          setTouched(new Set(Object.keys(data.errors) as FieldName[]));
          throw new Error("Some answers need another look. Please check the highlighted fields.");
        } else throw new Error("");
      }
      if (ok) {
        setSubmittedName(values.fullName.trim());
        setStatus("success");
        trackLead({ studyLevel: values.studyLevel, englishTest: values.englishTest });
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* ignore */
        }
      }
    } catch (error) {
      setStatus("error");
      setServerError(
        (error instanceof Error && error.message) ||
          "Sorry, something went wrong on our side and your registration wasn't sent. Your answers are saved, so please try again.",
      );
    }
  };

  const startOver = () => {
    setValues(emptyValues);
    setTouched(new Set());
    setStep(0);
    setRestored(false);
    setStatus("idle");
    setServerError("");
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  /* ───────── success screen ───────── */
  if (status === "success") {
    return (
      <FormShell cardRef={cardRef}>
        <div ref={successRef} tabIndex={-1} role="status" aria-live="polite" className="px-6 py-12 text-center outline-none sm:px-10 sm:py-16">
          <div className="mx-auto grid size-16 place-items-center rounded-full bg-success/10 text-success">
            <CheckCircle2 className="size-9" aria-hidden="true" />
          </div>
          <h3 className="mt-6 text-[24px] leading-tight font-semibold tracking-[-0.025em] sm:text-[28px]">Thank you, {submittedName}!</h3>
          <p className="mx-auto mt-3 max-w-[420px] text-[17px] text-ink-soft">Our team will contact you on WhatsApp within 24 hours.</p>
          <a
            href={whatsappUrl(`Hi UniBee, I just registered on your website. My name is ${submittedName}.`)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => trackWhatsAppClick("thank-you")}
            className="btn btn-whatsapp mt-8"
          >
            <SocialIcon network="whatsapp" className="size-5" /> Chat on WhatsApp now
          </a>
          {IS_PREVIEW && (
            <p className="mx-auto mt-6 max-w-[420px] rounded-[var(--radius-card)] bg-amber-50 p-3 text-[13px] text-amber-900">
              Preview mode: this test submission wasn&apos;t sent anywhere. On the live site it is saved and emailed to your team.
            </p>
          )}
          <button type="button" onClick={startOver} className="mt-6 block w-full text-[14px] text-muted underline-offset-4 hover:text-ink hover:underline">
            Register another student
          </button>
        </div>
      </FormShell>
    );
  }

  const scored = SCORED_TESTS[values.englishTest];
  const whyLen = values.whyLithuania.trim().length;

  return (
    <FormShell cardRef={cardRef}>
      <form id={formId} onSubmit={submit} noValidate aria-labelledby="reg-step-title" className="contents">
        {/* Progress */}
        <div className="border-b border-line px-5 pt-5 pb-4 sm:px-8 sm:pt-7">
          <div className="flex items-center justify-between text-[13px]">
            <span className="font-mono font-medium text-brand-dark">
              Step {step + 1} of {STEPS.length}
            </span>
            <span className="flex items-center gap-1.5 text-muted">
              Saved on this device
            </span>
          </div>
          <ol className="mt-3 grid grid-cols-3 gap-2" aria-label="Form progress">
            {STEPS.map((label, i) => (
              <li key={label} aria-current={i === step ? "step" : undefined}>
                <div className={`h-1 rounded-full transition-colors duration-300 ${i <= step ? "bg-brand" : "bg-line"}`} />
                <span className={`mt-2 flex items-center gap-1 text-[13px] font-medium ${i === step ? "text-ink" : i < step ? "text-ink-soft" : "text-muted"}`}>
                  {i < step && <Check className="size-3.5 text-success" aria-hidden="true" />}
                  {label}
                  {i < step && <span className="sr-only">(completed)</span>}
                </span>
              </li>
            ))}
          </ol>
        </div>

        <div className="space-y-5 px-5 py-6 sm:px-8 sm:py-7">
          {restored && step === 0 && (
            <div className="flex items-start justify-between gap-3 rounded-[var(--radius-card)] bg-brand-tint px-4 py-3 text-[14px] text-ink-soft">
              <span>Welcome back! We restored the details you saved earlier.</span>
              <button type="button" onClick={startOver} className="inline-flex shrink-0 items-center gap-1 font-semibold text-brand-dark hover:underline">
                <RotateCcw className="size-3.5" aria-hidden="true" /> Start over
              </button>
            </div>
          )}

          {values.university && (
            <div className="flex items-center justify-between gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[14px]">
              <span className="flex items-center gap-2 text-ink-soft">
                                <span>
                  Applying for: <strong className="text-ink">{values.university}</strong>
                </span>
              </span>
              <button
                type="button"
                onClick={() => set("university", "")}
                className="grid size-8 shrink-0 place-items-center rounded-full hover:bg-white"
                aria-label={`Remove ${values.university}`}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          )}

          <h3 id="reg-step-title" ref={stepHeadingRef} tabIndex={-1} className="text-[20px] font-semibold tracking-[-0.02em] outline-none">
            {step === 0 && "Personal contact information"}
            {step === 1 && "Academic profile"}
            {step === 2 && "Almost done"}
          </h3>
          <p className="-mt-3 text-[14px] text-muted">
            Fields marked <span className="text-danger">*</span> are required.
          </p>

          {/* ───────── STEP 1 ───────── */}
          {step === 0 && (
            <>
              <div>
                <Label name="fullName" required>Full name</Label>
                <input {...bind("fullName")} type="text" autoComplete="name" autoCapitalize="words" placeholder="As written on your certificates" className="field-input" required />
                <FieldError name="fullName" error={err("fullName")} />
              </div>

              <div>
                <Label name="email" required>Email address</Label>
                <input {...bind("email", { help: true })} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="name@gmail.com" className="field-input" required />
                <p id={`${fid("email")}-help`} className="field-help">Please use an email you keep active and check regularly. We&apos;ll send important updates here.</p>
                <FieldError name="email" error={err("email")} />
              </div>

              <PhoneInput label="Phone number (WhatsApp)" name="phone" bind={bind} help="This number must have an active WhatsApp account." error={err("phone")} />

              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px] text-ink-soft">
                <input
                  type="checkbox"
                  checked={values.sameWhatsapp}
                  onChange={(e) => set("sameWhatsapp", e.target.checked)}
                  className="size-5 shrink-0 rounded accent-brand-dark"
                />
                Same number for calls and WhatsApp
              </label>

              {!values.sameWhatsapp && <PhoneInput label="WhatsApp number" name="whatsapp" bind={bind} error={err("whatsapp")} />}
            </>
          )}

          {/* ───────── STEP 2 ───────── */}
          {step === 1 && (
            <>
              {(["ssc", "hsc"] as const).map((lvl) => (
                <div key={lvl} className="border-t border-line pt-5">
                  <p className="mb-4 flex items-center gap-2 text-[15px] font-semibold">
                    {lvl.toUpperCase()} <span className="font-normal text-muted">(or equivalent)</span>
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <Label name={`${lvl}Gpa`} required>GPA</Label>
                      <input {...bind(`${lvl}Gpa`)} type="text" inputMode="decimal" autoComplete="off" placeholder="e.g. 5.00" className="field-input" required />
                      <FieldError name={`${lvl}Gpa`} error={err(`${lvl}Gpa`)} />
                    </div>
                    <div>
                      <Label name={`${lvl}Year`} required>Passing year</Label>
                      <select {...bind(`${lvl}Year`)} className="field-input" required>
                        <option value="">Select year</option>
                        {years.map((y) => (
                          <option key={y}>{y}</option>
                        ))}
                      </select>
                      <FieldError name={`${lvl}Year`} error={err(`${lvl}Year`)} />
                    </div>
                  </div>
                  <div className="mt-4">
                    <Fieldset legend="Group" required name={`${lvl}Group`} error={err(`${lvl}Group`)}>
                      <ChoiceGroup name={`${lvl}Group`} options={GROUPS} value={values[`${lvl}Group`]} onChange={(v) => { set(`${lvl}Group`, v); touch(`${lvl}Group`); }} invalid={!!err(`${lvl}Group`)} cols={3} />
                    </Fieldset>
                  </div>
                </div>
              ))}

              <Fieldset legend="Interested study level" required name="studyLevel" error={err("studyLevel")}>
                <ChoiceGroup
                  name="studyLevel"
                  options={STUDY_LEVELS}
                  value={values.studyLevel}
                  onChange={(v) => {
                    setValues((s) => ({ ...s, studyLevel: v, hasBachelor: v === "Master's" ? true : s.hasBachelor }));
                    touch("studyLevel");
                  }}
                  invalid={!!err("studyLevel")}
                  cols={2}
                />
              </Fieldset>

              <div className="border-t border-line pt-5">
                <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px] font-medium text-ink">
                  <input type="checkbox" checked={values.hasBachelor} onChange={(e) => set("hasBachelor", e.target.checked)} className="size-5 shrink-0 rounded accent-brand-dark" />
                  I have a bachelor&apos;s degree <span className="font-normal text-muted">(optional, for master&apos;s applicants)</span>
                </label>
                {values.hasBachelor && (
                  <div className="mt-4 grid gap-4 sm:grid-cols-3">
                    <div className="sm:col-span-3">
                      <Label name="bachelorSubject" required>Subject</Label>
                      <input {...bind("bachelorSubject")} type="text" placeholder="e.g. BBA in Finance" className="field-input" />
                      <FieldError name="bachelorSubject" error={err("bachelorSubject")} />
                    </div>
                    <div className="sm:col-span-1">
                      <Label name="bachelorCgpa" required>CGPA (out of 4)</Label>
                      <input {...bind("bachelorCgpa")} type="text" inputMode="decimal" placeholder="e.g. 3.40" className="field-input" />
                      <FieldError name="bachelorCgpa" error={err("bachelorCgpa")} />
                    </div>
                    <div className="sm:col-span-2">
                      <Label name="bachelorYear" required>Passing year</Label>
                      <select {...bind("bachelorYear")} className="field-input">
                        <option value="">Select year</option>
                        {years.map((y) => (
                          <option key={y}>{y}</option>
                        ))}
                      </select>
                      <FieldError name="bachelorYear" error={err("bachelorYear")} />
                    </div>
                  </div>
                )}
              </div>

              <div>
                <Label name="englishTest" required>English proficiency test</Label>
                <select {...bind("englishTest")} className="field-input" required>
                  <option value="">Select an option</option>
                  {ENGLISH_TESTS.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <FieldError name="englishTest" error={err("englishTest")} />
              </div>

              {scored && (
                <div className="grid gap-4 rounded-[var(--radius-card)] bg-surface p-4 sm:grid-cols-2 sm:p-5">
                  <div>
                    <Label name="englishScore" required>Overall score</Label>
                    <input {...bind("englishScore", { help: true })} type="text" inputMode="decimal" placeholder={scored.hint.split("e.g. ")[1]} className="field-input" />
                    <p id={`${fid("englishScore")}-help`} className="field-help">{scored.hint}</p>
                    <FieldError name="englishScore" error={err("englishScore")} />
                  </div>
                  <div>
                    <Label name="englishTestDate">Test date <span className="font-normal text-muted">(optional)</span></Label>
                    <input {...bind("englishTestDate")} type="date" max={new Date().toISOString().slice(0, 10)} className="field-input" />
                    <FieldError name="englishTestDate" error={err("englishTestDate")} />
                  </div>
                </div>
              )}

              {values.englishTest === "Medium of Instruction (MOI)" && (
                <div className="rounded-[var(--radius-card)] bg-surface p-4 sm:p-5">
                  <Label name="moiDetails" required>Medium of Instruction details</Label>
                  <input {...bind("moiDetails")} type="text" placeholder="e.g. English Medium School / English Version" className="field-input" />
                  <FieldError name="moiDetails" error={err("moiDetails")} />
                </div>
              )}

              {values.englishTest === "Not taken yet" && (
                <div className="space-y-4 rounded-[var(--radius-card)] bg-surface p-4 sm:p-5">
                  <Fieldset legend="Do you plan to take a test?" required name="planToTakeTest" error={err("planToTakeTest")}>
                    <ChoiceGroup name="planToTakeTest" options={PLAN_OPTIONS} value={values.planToTakeTest} onChange={(v) => { set("planToTakeTest", v); touch("planToTakeTest"); }} invalid={!!err("planToTakeTest")} cols={3} />
                  </Fieldset>
                  <div>
                    <Label name="moiIfEnglish">Medium of Instruction (if English) <span className="font-normal text-muted">(optional)</span></Label>
                    <input {...bind("moiIfEnglish")} type="text" placeholder="e.g. English Version school" className="field-input" />
                    <FieldError name="moiIfEnglish" error={err("moiIfEnglish")} />
                  </div>
                </div>
              )}

              <div>
                <Label name="whyLithuania" required>Why Lithuania?</Label>
                <textarea {...bind("whyLithuania", { help: true })} rows={4} maxLength={TEXT_MAX} placeholder="Tell us why you want to study in Lithuania…" className="field-input min-h-28 resize-y" />
                <div className="mt-1.5 flex items-start justify-between gap-3">
                  <p id={`${fid("whyLithuania")}-help`} className="text-[14px] text-muted">At least {WHY_MIN} characters. A few honest sentences is perfect.</p>
                  <p className={`shrink-0 font-mono text-[13px] ${whyLen >= WHY_MIN ? "text-success" : "text-muted"}`} aria-live="polite">
                    {whyLen}/{WHY_MIN}
                    {whyLen >= WHY_MIN && <Check className="ml-1 inline size-3.5" aria-label="minimum reached" />}
                  </p>
                </div>
                <FieldError name="whyLithuania" error={err("whyLithuania")} />
              </div>
            </>
          )}

          {/* ───────── STEP 3 ───────── */}
          {step === 2 && (
            <>
              <Summary values={values} onEdit={goTo} />

              <div>
                <Label name="comments">Comments / questions <span className="font-normal text-muted">(optional)</span></Label>
                <textarea {...bind("comments")} rows={4} maxLength={TEXT_MAX} placeholder="Anything you'd like us to know, e.g. budget, preferred city or program" className="field-input min-h-28 resize-y" />
                <FieldError name="comments" error={err("comments")} />
              </div>

              <div>
                <label className={`flex cursor-pointer items-start gap-3 rounded-[var(--radius-card)] border p-4 text-[15px] leading-snug ${err("consent") ? "border-danger bg-[#fffafa]" : "border-line"}`}>
                  <input
                    id={fid("consent")}
                    name="consent"
                    type="checkbox"
                    checked={values.consent}
                    onChange={(e) => { set("consent", e.target.checked); touch("consent"); }}
                    aria-invalid={err("consent") ? true : undefined}
                    aria-describedby={err("consent") ? `${fid("consent")}-error` : undefined}
                    className="mt-0.5 size-5 shrink-0 rounded accent-brand-dark"
                  />
                  <span>
                    I agree that UniBee may contact me by phone, WhatsApp and email.<span className="req" aria-hidden="true">*</span>
                  </span>
                </label>
                <FieldError name="consent" error={err("consent")} />
              </div>
            </>
          )}

          {/* Honeypot: hidden from people, bots fill it in */}
          <div className="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden="true">
            <label htmlFor="reg-website">Website</label>
            <input id="reg-website" name="website" type="text" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
          </div>

          {status === "error" && serverError && (
            <div role="alert" className="flex gap-3 rounded-[var(--radius-card)] border border-danger/30 bg-[#fef2f2] p-4 text-[15px] text-[#991b1b]">
              <AlertCircle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <div>
                <p>{serverError}</p>
                <p className="mt-1 text-[14px]">
                  Still stuck?{" "}
                  <a href={whatsappUrl()} target="_blank" rel="noopener noreferrer" className="font-semibold underline">
                    Message us on WhatsApp
                  </a>
                  .
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col-reverse gap-3 border-t border-line bg-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8 sm:py-5">
          {step > 0 ? (
            <button type="button" onClick={() => goTo(step - 1)} className="btn min-h-12 text-muted hover:bg-white hover:text-ink">
              <ArrowLeft className="size-5" aria-hidden="true" /> Back
            </button>
          ) : (
            <span className="hidden text-[14px] text-muted sm:block">Takes about 5 minutes</span>
          )}
          {step < 2 ? (
            <button type="submit" className="btn btn-primary min-h-12 px-6 sm:min-w-44">
              Continue <ArrowRight className="size-5" aria-hidden="true" />
            </button>
          ) : (
            <button type="submit" className="btn btn-primary min-h-12 px-6 sm:min-w-56" disabled={status === "submitting"} aria-busy={status === "submitting"}>
              {status === "submitting" ? (
                <>
                  <Loader2 className="size-5 animate-spin" aria-hidden="true" /> Submitting…
                </>
              ) : status === "error" ? (
                <>Try again</>
              ) : (
                <>Submit Registration</>
              )}
            </button>
          )}
        </div>
      </form>
    </FormShell>
  );
}

/* ───────────────────────── helpers & sub-components ───────────────────────── */

function withUniversity(v: RegistrationValues, name: string): RegistrationValues {
  const line = `I'm interested in applying to ${name}.`;
  const comments = v.comments.includes(name) ? v.comments : v.comments.trim() ? `${line}\n${v.comments}` : line;
  return { ...v, university: name, comments };
}

function safeSession(key: string) {
  try {
    return sessionStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

/** Framed panel around the form. */
function FormShell({ children, cardRef }: { children: ReactNode; cardRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={cardRef} className="frame relative scroll-mt-24">
      {children}
    </div>
  );
}

function PhoneInput({
  label,
  name,
  bind,
  help,
  error,
}: {
  label: string;
  name: "phone" | "whatsapp";
  bind: (n: FieldName, o?: { help?: boolean }) => Record<string, unknown>;
  help?: string;
  error?: string;
}) {
  return (
    <div>
      <Label name={name} required>{label}</Label>
      <div className="flex">
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-l-[var(--radius-input)] border border-r-0 border-line-strong bg-surface px-3 text-[15px] font-medium text-ink-soft">
          <Flag country="bd" /> +880
        </span>
        <input
          {...bind(name, { help: !!help })}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder="01XXXXXXXXX"
          maxLength={16}
          className="field-input rounded-l-none"
          required
        />
      </div>
      {help && <p id={`${fid(name)}-help`} className="field-help">{help}</p>}
      <FieldError name={name} error={error} />
    </div>
  );
}

function ChoiceGroup({
  name,
  options,
  value,
  onChange,
  invalid,
  cols,
}: {
  name: string;
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  cols: 2 | 3;
}) {
  return (
    <div className={`grid gap-2 ${cols === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
      {options.map((o, i) => (
        <label key={o} className={`choice justify-center text-center ${invalid ? "border-danger" : ""}`}>
          <input
            id={i === 0 ? fid(name) : undefined}
            type="radio"
            name={name}
            value={o}
            checked={value === o}
            onChange={() => onChange(o)}
            className="sr-only"
          />
          <span className="font-medium">{o}</span>
        </label>
      ))}
    </div>
  );
}

function Summary({ values, onEdit }: { values: RegistrationValues; onEdit: (step: number) => void }) {
  const english =
    values.englishTest && SCORED_TESTS[values.englishTest] ? `${values.englishTest} ${values.englishScore}` : values.englishTest;
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface/60 p-4 text-[14px]">
      <div className="flex items-center justify-between">
        <p className="font-semibold text-ink">Your details</p>
      </div>
      <dl className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
        <SummaryRow label="Name" value={values.fullName} onEdit={() => onEdit(0)} />
        <SummaryRow label="WhatsApp" value={values.sameWhatsapp ? values.phone : values.whatsapp} onEdit={() => onEdit(0)} />
        <SummaryRow label="SSC / HSC" value={`${values.sscGpa} / ${values.hscGpa}`} onEdit={() => onEdit(1)} />
        <SummaryRow label="Level · English" value={`${values.studyLevel} · ${english}`} onEdit={() => onEdit(1)} />
      </dl>
    </div>
  );
}

function SummaryRow({ label, value, onEdit }: { label: string; value: string; onEdit: () => void }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="shrink-0 text-muted">{label}:</dt>
      <dd className="min-w-0 truncate font-medium text-ink">{value}</dd>
      <button type="button" onClick={onEdit} className="ml-auto shrink-0 text-[13px] font-semibold text-brand-dark hover:underline">
        Edit<span className="sr-only"> {label}</span>
      </button>
    </div>
  );
}
