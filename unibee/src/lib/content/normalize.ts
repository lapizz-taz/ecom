/**
 * Cleans content coming from the CMS before it is saved or shown.
 * Every field is coerced to the right type and length, unsafe URLs are
 * dropped, and anything missing falls back to the defaults.
 */
import { ICON_NAMES } from "@/components/ui/icon-names";
import { defaultContent } from "./defaults";
import { SOCIAL_NETWORKS, type SiteContent, type University } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});

/** Trimmed string, capped in length; falls back when the value isn't a string. */
export function str(v: unknown, fallback = "", max = 2000): string {
  return typeof v === "string" ? v.trim().slice(0, max) : fallback;
}
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const list = <T>(v: unknown, map: (item: unknown, i: number) => T | null, max = 100): T[] =>
  (Array.isArray(v) ? v.slice(0, max) : []).map(map).filter((x): x is T => x !== null);
const lines = (v: unknown, max = 50): string[] => list(v, (s) => str(s, "", 300) || null, max);

/** http(s) links only (blocks javascript: and similar). */
export function safeUrl(v: unknown): string {
  const s = str(v, "", 1000);
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : "";
}
/** Images: uploaded https URLs or paths inside /public. */
export function safeImage(v: unknown, fallback = ""): string {
  const s = str(v, "", 1000);
  if (!s) return "";
  if (/^https:\/\/[^\s"'<>]+$/i.test(s)) return s;
  if (/^\/(?!\/)[\w\-./%]+$/.test(s) && !s.includes("..")) return s;
  return fallback;
}
const icon = (v: unknown) => ((ICON_NAMES as readonly string[]).includes(v as string) ? (v as string) : "ClipboardCheck");
const color = (v: unknown) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : "#64748b");

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "university"
  );
}

/** List of { title, text } items; items without a title are dropped. */
const titledList = (v: unknown, max: number) =>
  list(v, (item) => {
    const s = obj(item);
    const title = str(s.title, "", 80);
    return title ? { title, text: str(s.text, "", 400) } : null;
  }, max);

function university(v: unknown, used: Set<string>): University | null {
  const u = obj(v);
  const name = str(u.name, "", 200);
  if (!name) return null;
  let slug = slugify(str(u.slug) || name);
  while (used.has(slug)) slug = `${slug}-2`;
  used.add(slug);
  const programs = obj(u.programs);
  const req = obj(u.requirements);
  return {
    slug,
    name,
    shortName: str(u.shortName, "", 30) || name.split(/\s+/).map((w) => w[0]).join("").slice(0, 4).toUpperCase(),
    city: str(u.city, "", 80),
    logo: safeImage(u.logo),
    color: color(u.color),
    about: str(u.about, "", 1000),
    programs: { bachelor: lines(programs.bachelor), master: lines(programs.master) },
    tuition: str(u.tuition, "", 120),
    intakes: lines(u.intakes, 10),
    requirements: { academic: str(req.academic, "", 600), english: str(req.english, "", 600) },
    deadline: str(u.deadline, "", 200),
    website: safeUrl(u.website),
    placeholder: bool(u.placeholder, false),
  };
}

export function normalizeContent(input: unknown): SiteContent {
  const d = defaultContent;
  const c = obj(input);

  const g = obj(c.general);
  const ann = obj(g.announcement);
  const contact = obj(c.contact);
  const hero = obj(c.hero);
  const services = obj(c.services);
  const process = obj(c.process);
  const ep = obj(c.englishPrep);
  const ab = obj(c.about);
  const ins = obj(ep.instructor);
  const video = obj(ep.video);

  const socialIn = Array.isArray(c.socials) ? (c.socials as unknown[]).map(obj) : null;
  const used = new Set<string>();

  return {
    general: {
      name: str(g.name, d.general.name, 60) || d.general.name,
      tagline: str(g.tagline, d.general.tagline, 120),
      description: str(g.description, d.general.description, 300) || d.general.description,
      footerBlurb: str(g.footerBlurb, d.general.footerBlurb, 300),
      page3Name: str(g.page3Name, d.general.page3Name, 40) || d.general.page3Name,
      announcement: { text: str(ann.text, d.general.announcement.text, 160), linkText: str(ann.linkText, d.general.announcement.linkText, 40) },
      showPlaceholderBadges: bool(g.showPlaceholderBadges, d.general.showPlaceholderBadges),
    },
    contact: {
      phone: str(contact.phone, d.contact.phone, 30).replace(/[^\d+A-Z_]/gi, ""),
      phoneDisplay: str(contact.phoneDisplay, d.contact.phoneDisplay, 40),
      whatsapp: str(contact.whatsapp, d.contact.whatsapp, 30).replace(/[^\dA-Z_]/gi, ""),
      whatsappDisplay: str(contact.whatsappDisplay, d.contact.whatsappDisplay, 40),
      whatsappMessage: str(contact.whatsappMessage, d.contact.whatsappMessage, 300),
      email: str(contact.email, d.contact.email, 150),
      address: str(contact.address, d.contact.address, 300),
      mapsQuery: str(contact.mapsQuery, d.contact.mapsQuery, 300) || d.contact.mapsQuery,
      hours: str(contact.hours, d.contact.hours, 120),
    },
    // Fixed set of networks; an empty URL hides that icon.
    socials: SOCIAL_NETWORKS.map(({ network, label }) => {
      const found = socialIn?.find((s) => s.network === network);
      const fallback = d.socials.find((s) => s.network === network);
      return { network, label, url: found ? (network === "whatsapp" ? "" : safeUrl(found.url)) : fallback?.url ?? "" };
    }),
    hero: {
      title: str(hero.title, d.hero.title, 120) || d.hero.title,
      subtitle: str(hero.subtitle, d.hero.subtitle, 300),
      trustLine: str(hero.trustLine, d.hero.trustLine, 200),
      imageDesktop: safeImage(hero.imageDesktop, d.hero.imageDesktop) || d.hero.imageDesktop,
      imageMobile: safeImage(hero.imageMobile, d.hero.imageMobile) || d.hero.imageMobile,
      imageAlt: str(hero.imageAlt, d.hero.imageAlt, 200),
      placeholder: bool(hero.placeholder, d.hero.placeholder),
    },
    about: {
      placeholder: bool(ab.placeholder, d.about.placeholder),
      title: str(ab.title, d.about.title, 80) || d.about.title,
      intro: str(ab.intro, d.about.intro, 400),
      story: str(ab.story, d.about.story, 1500),
      mission: str(ab.mission, d.about.mission, 400),
      whatWeDo: Array.isArray(ab.whatWeDo) ? titledList(ab.whatWeDo, 8) : d.about.whatWeDo,
      values: Array.isArray(ab.values) ? titledList(ab.values, 6) : d.about.values,
    },
    universities: Array.isArray(c.universities) ? list(c.universities, (u) => university(u, used), 60) : d.universities,
    services: {
      items: Array.isArray(services.items)
        ? list(services.items, (v) => {
            const s = obj(v);
            const title = str(s.title, "", 120);
            return title ? { icon: icon(s.icon), title, description: str(s.description, "", 400) } : null;
          }, 30)
        : d.services.items,
      placeholder: bool(services.placeholder, d.services.placeholder),
    },
    process: {
      steps: Array.isArray(process.steps)
        ? list(process.steps, (v) => {
            const s = obj(v);
            const title = str(s.title, "", 120);
            return title ? { icon: icon(s.icon), title, text: str(s.text, "", 400), time: str(s.time, "", 60) } : null;
          }, 30)
        : d.process.steps,
      documents: Array.isArray(process.documents) ? lines(process.documents, 40) : d.process.documents,
      placeholder: bool(process.placeholder, d.process.placeholder),
    },
    englishPrep: {
      placeholder: bool(ep.placeholder, d.englishPrep.placeholder),
      title: str(ep.title, d.englishPrep.title, 120) || d.englishPrep.title,
      subtitle: str(ep.subtitle, d.englishPrep.subtitle, 300),
      learn: Array.isArray(ep.learn)
        ? list(ep.learn, (v) => {
            const s = obj(v);
            const title = str(s.title, "", 80);
            return title ? { icon: icon(s.icon), title, text: str(s.text, "", 300) } : null;
          }, 12)
        : d.englishPrep.learn,
      format: Array.isArray(ep.format)
        ? list(ep.format, (v) => {
            const s = obj(v);
            const label = str(s.label, "", 60);
            return label ? { icon: icon(s.icon), label, value: str(s.value, "", 160) } : null;
          }, 8)
        : d.englishPrep.format,
      instructor: {
        name: str(ins.name, d.englishPrep.instructor.name, 100),
        role: str(ins.role, d.englishPrep.instructor.role, 100),
        photo: safeImage(ins.photo),
        bio: str(ins.bio, d.englishPrep.instructor.bio, 800),
        qualifications: Array.isArray(ins.qualifications) ? lines(ins.qualifications, 10) : d.englishPrep.instructor.qualifications,
        stats: Array.isArray(ins.stats)
          ? list(ins.stats, (v) => {
              const s = obj(v);
              const label = str(s.label, "", 40);
              return label ? { value: str(s.value, "", 20), label } : null;
            }, 3)
          : d.englishPrep.instructor.stats,
      },
      video: {
        youtube: str(video.youtube, d.englishPrep.video.youtube, 200),
        title: str(video.title, d.englishPrep.video.title, 120),
        caption: str(video.caption, d.englishPrep.video.caption, 300),
      },
    },
  };
}
