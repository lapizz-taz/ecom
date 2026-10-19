"use client";

import { AlertTriangle, Check, ExternalLink, History, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SiteContent, University } from "@/lib/content/types";
import { Field, IconSelect, ImageInput, LinesInput, ListEditor, TextInput, Toggle } from "./fields";

type Version = { id: string; savedAt: string; data: SiteContent };
type Backend = "supabase" | "local-file" | "none";

const SECTIONS = [
  { id: "general", label: "General", hint: "Name, announcement, placeholders" },
  { id: "contact", label: "Contact & social", hint: "Phone, WhatsApp, email, links" },
  { id: "hero", label: "Home hero", hint: "Headline and cover photo" },
  { id: "about", label: "About us", hint: "Who we are, what we do" },
  { id: "universities", label: "Universities", hint: "Partner list and details" },
  { id: "services", label: "Services", hint: "Service cards" },
  { id: "process", label: "Process", hint: "Steps and documents" },
  { id: "englishPrep", label: "English Prep", hint: "Classes page" },
  { id: "versions", label: "Version history", hint: "Restore an earlier save" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

const fmt = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "never";

function Panel({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-[14px] border border-line bg-white p-5 sm:p-6">
      <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
      {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  );
}
const Grid = ({ children }: { children: ReactNode }) => <div className="grid gap-5 sm:grid-cols-2">{children}</div>;

const newUniversity = (): University => ({
  slug: "",
  name: "New university",
  shortName: "",
  city: "",
  logo: "",
  color: "#64748b",
  about: "",
  programs: { bachelor: [], master: [] },
  tuition: "",
  intakes: ["September"],
  requirements: { academic: "", english: "" },
  deadline: "",
  website: "",
  placeholder: false,
});

export function ContentEditor({
  initial,
  updatedAt: initialUpdatedAt,
  versions: initialVersions,
  backend,
}: {
  initial: SiteContent;
  updatedAt: string | null;
  versions: Version[];
  backend: Backend;
}) {
  const [content, setContent] = useState<SiteContent>(initial);
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(initial));
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt);
  const [versions, setVersions] = useState(initialVersions);
  const [section, setSection] = useState<SectionId>("general");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const [resetKey, setResetKey] = useState(0);

  const dirty = useMemo(() => JSON.stringify(content) !== savedJson, [content, savedJson]);
  const readOnly = backend === "none";

  // Warn before leaving with unsaved changes
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const set = <K extends keyof SiteContent>(key: K, patch: Partial<SiteContent[K]> | SiteContent[K]) =>
    setContent((c) => ({ ...c, [key]: Array.isArray(patch) ? patch : { ...(c[key] as object), ...(patch as object) } }));

  const save = useCallback(async () => {
    if (saving || readOnly) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "Couldn't save. Please try again.");
      setContent(data.content);
      setSavedJson(JSON.stringify(data.content));
      setUpdatedAt(data.updatedAt);
      setVersions((v) => [{ id: `local-${Date.now()}`, savedAt: data.updatedAt, data: data.content }, ...v].slice(0, 15));
      setResetKey((k) => k + 1);
      setNotice({ kind: "ok", text: "Saved. The website now shows your changes." });
    } catch (e) {
      setNotice({ kind: "error", text: e instanceof Error ? e.message : "Couldn't save." });
    } finally {
      setSaving(false);
    }
  }, [content, readOnly, saving]);

  // Ctrl/Cmd + S saves
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const discard = () => {
    setContent(JSON.parse(savedJson));
    setResetKey((k) => k + 1);
    setNotice({ kind: "info", text: "Changes discarded." });
  };

  const g = content.general;
  const c = content.contact;
  const h = content.hero;
  const ep = content.englishPrep;

  return (
    <div className="container-page py-6 pb-32 md:py-8">
      <div className="mb-6 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">Website content</h1>
          <p className="text-[13px] text-muted">
            Last saved: {fmt(updatedAt)}
            {backend === "local-file" && " · stored on this computer (development)"}
          </p>
        </div>
      </div>

      {readOnly && (
        <div className="mb-6 flex gap-3 rounded-[12px] border border-amber-300 bg-amber-50 p-4 text-[14px] text-amber-900">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <p>
            Editing is switched off because no database is connected. Add <code className="font-mono">SUPABASE_URL</code> and{" "}
            <code className="font-mono">SUPABASE_SERVICE_ROLE_KEY</code> in Vercel (see README → CMS setup). You can still look around.
          </p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        {/* Section navigation */}
        <nav aria-label="Content sections" className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:overflow-visible lg:px-0">
          <ul className="flex gap-1 lg:sticky lg:top-20 lg:flex-col">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setSection(s.id)}
                  aria-current={section === s.id ? "page" : undefined}
                  className={`w-full rounded-[10px] px-3 py-2 text-left whitespace-nowrap transition ${
                    section === s.id ? "bg-white text-ink shadow-[0_0_0_1px_var(--color-line)]" : "text-muted hover:bg-white/60 hover:text-ink"
                  }`}
                >
                  <span className="block text-[14px] font-medium">{s.label}</span>
                  <span className="hidden text-[12px] text-faint lg:block">{s.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <fieldset disabled={readOnly && section !== "versions"} key={resetKey} className="min-w-0 space-y-5">
          {section === "general" && (
            <>
              <Panel title="Site basics" description="Shown in the footer, search results and link previews.">
                <Grid>
                  <TextInput label="Business name" value={g.name} onChange={(v) => set("general", { name: v })} maxLength={60} />
                  <TextInput label="Tagline" value={g.tagline} onChange={(v) => set("general", { tagline: v })} />
                </Grid>
                <TextInput label="Short description (Google & link previews)" value={g.description} onChange={(v) => set("general", { description: v })} multiline rows={2} maxLength={300} hint="Around 150 characters works best." />
                <TextInput label="Footer text" value={g.footerBlurb} onChange={(v) => set("general", { footerBlurb: v })} />
                <TextInput label="Page 3 name (menu & page title)" value={g.page3Name} onChange={(v) => set("general", { page3Name: v })} maxLength={40} hint="The page address stays /english-prep." />
              </Panel>
              <Panel title="Announcement" description="Short message shown on the Home page. Leave the text empty to hide it.">
                <Grid>
                  <TextInput label="Text" value={g.announcement.text} onChange={(v) => set("general", { announcement: { ...g.announcement, text: v } })} />
                  <TextInput label="Link text" value={g.announcement.linkText} onChange={(v) => set("general", { announcement: { ...g.announcement, linkText: v } })} />
                </Grid>
              </Panel>
              <Panel title="Placeholder tags">
                <Toggle
                  label="Show amber “Placeholder” tags"
                  hint="Marks content that still needs real information. Switch off before launch."
                  checked={g.showPlaceholderBadges}
                  onChange={(v) => set("general", { showPlaceholderBadges: v })}
                />
              </Panel>
            </>
          )}

          {section === "contact" && (
            <>
              <Panel title="Contact details" description="Used in the contact section, footer, WhatsApp buttons and Google listing.">
                <Grid>
                  <TextInput label="Phone (for calls)" value={c.phone} onChange={(v) => set("contact", { phone: v })} placeholder="+8801712345678" hint="International format, no spaces." />
                  <TextInput label="Phone (as shown)" value={c.phoneDisplay} onChange={(v) => set("contact", { phoneDisplay: v })} placeholder="+880 1712-345678" />
                  <TextInput label="WhatsApp number" value={c.whatsapp} onChange={(v) => set("contact", { whatsapp: v })} placeholder="8801712345678" hint="Digits only, with 880. Every WhatsApp button uses this." />
                  <TextInput label="WhatsApp (as shown)" value={c.whatsappDisplay} onChange={(v) => set("contact", { whatsappDisplay: v })} />
                </Grid>
                <TextInput label="WhatsApp pre-filled message" value={c.whatsappMessage} onChange={(v) => set("contact", { whatsappMessage: v })} />
                <Grid>
                  <TextInput label="Email" value={c.email} onChange={(v) => set("contact", { email: v })} />
                  <TextInput label="Office hours" value={c.hours} onChange={(v) => set("contact", { hours: v })} />
                </Grid>
                <TextInput label="Office address" value={c.address} onChange={(v) => set("contact", { address: v })} multiline rows={2} />
                <TextInput label="Map location" value={c.mapsQuery} onChange={(v) => set("contact", { mapsQuery: v })} hint="Your full address or exact business name as it appears on Google Maps." />
              </Panel>
              <Panel title="Social media" description="Leave a link empty to hide that icon. The WhatsApp link uses the number above.">
                <Grid>
                  {content.socials
                    .filter((s) => s.network !== "whatsapp")
                    .map((s) => (
                      <TextInput
                        key={s.network}
                        label={s.label}
                        value={s.url}
                        placeholder="https://"
                        onChange={(v) => set("socials", content.socials.map((x) => (x.network === s.network ? { ...x, url: v } : x)))}
                      />
                    ))}
                </Grid>
              </Panel>
            </>
          )}

          {section === "hero" && (
            <Panel title="Home hero" description="The first thing visitors see.">
              <TextInput label="Headline" value={h.title} onChange={(v) => set("hero", { title: v })} maxLength={120} />
              <TextInput label="Text under the headline" value={h.subtitle} onChange={(v) => set("hero", { subtitle: v })} multiline rows={2} maxLength={300} />
              <TextInput label="Small trust line" value={h.trustLine} onChange={(v) => set("hero", { trustLine: v })} hint="Leave empty to hide." />
              <ImageInput label="Cover photo (computer)" value={h.imageDesktop} onChange={(v) => set("hero", { imageDesktop: v })} hint="Landscape, about 2000×900 px." disabled={readOnly} />
              <ImageInput label="Cover photo (phone)" value={h.imageMobile} onChange={(v) => set("hero", { imageMobile: v })} hint="Portrait, about 800×1000 px." aspect="aspect-[4/5]" disabled={readOnly} />
              <TextInput label="Photo description (for screen readers & Google)" value={h.imageAlt} onChange={(v) => set("hero", { imageAlt: v })} />
              <Toggle label="Mark photo as placeholder" checked={h.placeholder} onChange={(v) => set("hero", { placeholder: v })} />
            </Panel>
          )}

          {section === "about" && (
            <>
              <Panel title="About us" description="The “About UniBee” section on the Home page.">
                <TextInput label="Section title" value={content.about.title} onChange={(v) => set("about", { title: v })} maxLength={80} />
                <TextInput label="Intro (next to the title)" value={content.about.intro} onChange={(v) => set("about", { intro: v })} multiline rows={3} maxLength={400} />
                <TextInput label="Who we are" value={content.about.story} onChange={(v) => set("about", { story: v })} multiline rows={5} maxLength={1500} />
                <TextInput label="Mission" value={content.about.mission} onChange={(v) => set("about", { mission: v })} multiline rows={2} maxLength={400} hint="Shown as a highlighted quote. Leave empty to hide." />
                <Toggle label="Mark text as placeholder" checked={content.about.placeholder} onChange={(v) => set("about", { placeholder: v })} />
              </Panel>
              <Panel title="What we do" description="Shown as a numbered list, in this order.">
                <ListEditor
                  items={content.about.whatWeDo}
                  onChange={(whatWeDo) => set("about", { whatWeDo })}
                  newItem={() => ({ title: "New item", text: "" })}
                  itemTitle={(i) => i.title}
                  addLabel="Add item"
                  max={8}
                  renderItem={(i, update) => (
                    <>
                      <TextInput label="Title" value={i.title} onChange={(v) => update({ title: v })} maxLength={80} />
                      <TextInput label="Text" value={i.text} onChange={(v) => update({ text: v })} multiline rows={2} maxLength={400} />
                    </>
                  )}
                />
              </Panel>
              <Panel title="How we work" description="Short values shown in a row under the section.">
                <ListEditor
                  items={content.about.values}
                  onChange={(values) => set("about", { values })}
                  newItem={() => ({ title: "New value", text: "" })}
                  itemTitle={(i) => i.title}
                  addLabel="Add value"
                  max={6}
                  renderItem={(i, update) => (
                    <>
                      <TextInput label="Title" value={i.title} onChange={(v) => update({ title: v })} maxLength={80} />
                      <TextInput label="Text" value={i.text} onChange={(v) => update({ text: v })} multiline rows={2} maxLength={400} />
                    </>
                  )}
                />
              </Panel>
            </>
          )}

          {section === "universities" && (
            <Panel title="Universities" description="Shown in the moving banner on the Home page, in this order. Click one to edit.">
              <ListEditor
                items={content.universities}
                onChange={(items) => set("universities", items)}
                newItem={newUniversity}
                itemTitle={(u) => `${u.name}${u.city ? ` · ${u.city}` : ""}${u.placeholder ? "  (to confirm)" : ""}`}
                addLabel="Add university"
                max={60}
                renderItem={(u, update) => (
                  <>
                    <Grid>
                      <TextInput label="Name" value={u.name} onChange={(v) => update({ name: v })} maxLength={200} />
                      <TextInput label="City" value={u.city} onChange={(v) => update({ city: v })} />
                      <TextInput label="Short name" value={u.shortName} onChange={(v) => update({ shortName: v })} maxLength={30} hint="e.g. KTU" />
                      <TextInput label="Official website" value={u.website} onChange={(v) => update({ website: v })} placeholder="https://" />
                    </Grid>
                    <ImageInput label="Logo" value={u.logo} onChange={(v) => update({ logo: v })} hint="Transparent PNG or WebP works best. Shown grey, in colour on hover." aspect="aspect-[3/2]" disabled={readOnly} />
                    <TextInput label="About (2–3 lines)" value={u.about} onChange={(v) => update({ about: v })} multiline rows={3} maxLength={1000} />
                    <Grid>
                      <LinesInput label="Popular bachelor's programs" value={u.programs.bachelor} onChange={(v) => update({ programs: { ...u.programs, bachelor: v } })} />
                      <LinesInput label="Popular master's programs" value={u.programs.master} onChange={(v) => update({ programs: { ...u.programs, master: v } })} />
                    </Grid>
                    <Grid>
                      <TextInput label="Tuition fee range" value={u.tuition} onChange={(v) => update({ tuition: v })} placeholder="€3,500 – €6,500 per year" />
                      <TextInput label="Application deadline" value={u.deadline} onChange={(v) => update({ deadline: v })} />
                    </Grid>
                    <LinesInput label="Intakes" value={u.intakes} onChange={(v) => update({ intakes: v })} rows={2} />
                    <Grid>
                      <TextInput label="Academic requirements" value={u.requirements.academic} onChange={(v) => update({ requirements: { ...u.requirements, academic: v } })} multiline rows={3} />
                      <TextInput label="English requirements" value={u.requirements.english} onChange={(v) => update({ requirements: { ...u.requirements, english: v } })} multiline rows={3} />
                    </Grid>
                    <Toggle label="Details still to be confirmed" hint="Shows a “to be confirmed” note in the pop-up." checked={u.placeholder} onChange={(v) => update({ placeholder: v })} />
                  </>
                )}
              />
            </Panel>
          )}

          {section === "services" && (
            <Panel title="Service cards" description="Shown on the Our Services page.">
              <ListEditor
                items={content.services.items}
                onChange={(items) => set("services", { items })}
                newItem={() => ({ icon: "ClipboardCheck", title: "New service", description: "" })}
                itemTitle={(s) => s.title}
                addLabel="Add service"
                max={30}
                renderItem={(s, update) => (
                  <>
                    <Grid>
                      <TextInput label="Title" value={s.title} onChange={(v) => update({ title: v })} />
                      <IconSelect value={s.icon} onChange={(v) => update({ icon: v })} />
                    </Grid>
                    <TextInput label="Description" value={s.description} onChange={(v) => update({ description: v })} multiline rows={2} maxLength={400} />
                  </>
                )}
              />
              <Toggle label="Mark list as placeholder" checked={content.services.placeholder} onChange={(v) => set("services", { placeholder: v })} />
            </Panel>
          )}

          {section === "process" && (
            <>
              <Panel title="How it works: steps" description="The timeline on the Our Services page, in order.">
                <ListEditor
                  items={content.process.steps}
                  onChange={(steps) => set("process", { steps })}
                  newItem={() => ({ icon: "ClipboardCheck", title: "New step", text: "", time: "" })}
                  itemTitle={(s) => `${s.title}${s.time ? ` · ${s.time}` : ""}`}
                  addLabel="Add step"
                  max={30}
                  renderItem={(s, update) => (
                    <>
                      <Grid>
                        <TextInput label="Title" value={s.title} onChange={(v) => update({ title: v })} />
                        <TextInput label="Estimated time" value={s.time} onChange={(v) => update({ time: v })} placeholder="1–2 weeks" />
                      </Grid>
                      <TextInput label="Short explanation" value={s.text} onChange={(v) => update({ text: v })} multiline rows={2} maxLength={400} />
                      <IconSelect value={s.icon} onChange={(v) => update({ icon: v })} />
                    </>
                  )}
                />
              </Panel>
              <Panel title="Documents you'll need">
                <LinesInput label="Documents" value={content.process.documents} onChange={(v) => set("process", { documents: v })} rows={8} />
                <Toggle label="Mark steps & documents as placeholder" checked={content.process.placeholder} onChange={(v) => set("process", { placeholder: v })} />
              </Panel>
            </>
          )}

          {section === "englishPrep" && (
            <>
              <Panel title="Page header">
                <TextInput label="Title" value={ep.title} onChange={(v) => set("englishPrep", { title: v })} />
                <TextInput label="Subtitle" value={ep.subtitle} onChange={(v) => set("englishPrep", { subtitle: v })} multiline rows={2} />
                <Toggle label="Mark page content as placeholder" checked={ep.placeholder} onChange={(v) => set("englishPrep", { placeholder: v })} />
              </Panel>
              <Panel title="What you'll learn">
                <ListEditor
                  items={ep.learn}
                  onChange={(learn) => set("englishPrep", { learn })}
                  newItem={() => ({ icon: "BookOpen", title: "New skill", text: "" })}
                  itemTitle={(l) => l.title}
                  addLabel="Add item"
                  max={12}
                  renderItem={(l, update) => (
                    <>
                      <Grid>
                        <TextInput label="Title" value={l.title} onChange={(v) => update({ title: v })} />
                        <IconSelect value={l.icon} onChange={(v) => update({ icon: v })} />
                      </Grid>
                      <TextInput label="Text" value={l.text} onChange={(v) => update({ text: v })} multiline rows={2} />
                    </>
                  )}
                />
              </Panel>
              <Panel title="Class details" description="Format, duration, schedule, batch size…">
                <ListEditor
                  items={ep.format}
                  onChange={(format) => set("englishPrep", { format })}
                  newItem={() => ({ icon: "Clock", label: "New detail", value: "" })}
                  itemTitle={(f) => `${f.label}${f.value ? `: ${f.value}` : ""}`}
                  addLabel="Add detail"
                  max={8}
                  renderItem={(f, update) => (
                    <>
                      <Grid>
                        <TextInput label="Label" value={f.label} onChange={(v) => update({ label: v })} />
                        <TextInput label="Value" value={f.value} onChange={(v) => update({ value: v })} />
                      </Grid>
                      <IconSelect value={f.icon} onChange={(v) => update({ icon: v })} />
                    </>
                  )}
                />
              </Panel>
              <Panel title="Instructor">
                <Grid>
                  <TextInput label="Name" value={ep.instructor.name} onChange={(v) => set("englishPrep", { instructor: { ...ep.instructor, name: v } })} />
                  <TextInput label="Role" value={ep.instructor.role} onChange={(v) => set("englishPrep", { instructor: { ...ep.instructor, role: v } })} />
                </Grid>
                <ImageInput label="Photo" value={ep.instructor.photo} onChange={(v) => set("englishPrep", { instructor: { ...ep.instructor, photo: v } })} hint="Square photo, at least 600×600 px." aspect="aspect-square" disabled={readOnly} />
                <TextInput label="Short bio" value={ep.instructor.bio} onChange={(v) => set("englishPrep", { instructor: { ...ep.instructor, bio: v } })} multiline rows={3} maxLength={800} />
                <LinesInput label="Qualifications" value={ep.instructor.qualifications} onChange={(v) => set("englishPrep", { instructor: { ...ep.instructor, qualifications: v } })} />
                <Field label="Stats (up to 3)">
                  <div className="grid gap-3 sm:grid-cols-3">
                    {[0, 1, 2].map((i) => {
                      const stat = ep.instructor.stats[i] ?? { value: "", label: "" };
                      const updateStat = (patch: Partial<typeof stat>) => {
                        const stats = [0, 1, 2].map((k) => (k === i ? { ...stat, ...patch } : ep.instructor.stats[k] ?? { value: "", label: "" }));
                        set("englishPrep", { instructor: { ...ep.instructor, stats } });
                      };
                      return (
                        <div key={i} className="space-y-2 rounded-[10px] border border-line p-3">
                          <TextInput label="Number" value={stat.value} onChange={(v) => updateStat({ value: v })} placeholder="500+" maxLength={20} />
                          <TextInput label="Label" value={stat.label} onChange={(v) => updateStat({ label: v })} placeholder="Students taught" maxLength={40} />
                        </div>
                      );
                    })}
                  </div>
                </Field>
              </Panel>
              <Panel title="Sample class video">
                <TextInput label="YouTube link or video ID" value={ep.video.youtube} onChange={(v) => set("englishPrep", { video: { ...ep.video, youtube: v } })} placeholder="https://www.youtube.com/watch?v=…" />
                <Grid>
                  <TextInput label="Title" value={ep.video.title} onChange={(v) => set("englishPrep", { video: { ...ep.video, title: v } })} />
                  <TextInput label="Caption" value={ep.video.caption} onChange={(v) => set("englishPrep", { video: { ...ep.video, caption: v } })} />
                </Grid>
              </Panel>
            </>
          )}

          {section === "versions" && (
            <Panel title="Version history" description="Every save is kept. Load an earlier version, check it, then press Save to publish it again.">
              {versions.length === 0 ? (
                <p className="text-[14px] text-muted">No saved versions yet.</p>
              ) : (
                <ul className="divide-y divide-line rounded-[12px] border border-line">
                  {versions.map((v, i) => (
                    <li key={v.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <span className="flex items-center gap-2 text-[14px] text-ink">
                        <History className="size-4 text-faint" aria-hidden="true" />
                        {fmt(v.savedAt)}
                        {i === 0 && <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] text-muted">latest</span>}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setContent(v.data);
                          setResetKey((k) => k + 1);
                          setNotice({ kind: "info", text: `Loaded the version from ${fmt(v.savedAt)}. Press Save to publish it.` });
                        }}
                        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-ink ring-1 ring-line-strong hover:bg-surface"
                      >
                        <RotateCcw className="size-3.5" aria-hidden="true" /> Load
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
        </fieldset>
      </div>

      {/* Save bar */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-white/95 backdrop-blur">
        <div className="container-page flex min-h-16 flex-wrap items-center justify-between gap-3 py-3">
          <p className="flex min-w-0 items-center gap-2 text-[13px]" role="status" aria-live="polite">
            {notice ? (
              <span className={notice.kind === "error" ? "text-danger" : notice.kind === "ok" ? "text-success" : "text-muted"}>
                {notice.kind === "ok" && <Check className="mr-1 inline size-4" aria-hidden="true" />}
                {notice.text}
                {notice.kind === "ok" && (
                  <a href="/" target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 font-medium text-ink underline underline-offset-4">
                    View site <ExternalLink className="size-3" aria-hidden="true" />
                  </a>
                )}
              </span>
            ) : dirty ? (
              <span className="text-amber-700">You have unsaved changes.</span>
            ) : (
              <span className="text-muted">All changes saved.</span>
            )}
          </p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={discard} disabled={!dirty || saving} className="min-h-10 rounded-full px-4 text-[14px] text-muted ring-1 ring-line hover:text-ink disabled:opacity-40">
              Discard
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving || readOnly}
              className="inline-flex min-h-10 items-center gap-2 rounded-full bg-brand-dark px-5 text-[14px] font-medium text-white transition hover:bg-brand-deeper disabled:opacity-40"
            >
              {saving && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
