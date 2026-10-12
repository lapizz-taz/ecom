import "server-only";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";
import { defaultContent } from "@/lib/content/defaults";
import { normalizeContent } from "@/lib/content/normalize";
import type { SiteContent } from "@/lib/content/types";

/**
 * Where CMS content and uploaded images live.
 *
 *  • Supabase (production): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 *    Tables `site_content` + `site_content_history` and the public storage
 *    bucket `site-media` (run docs/supabase-schema.sql once).
 *  • Local files (development only): .data/content.json, .data/uploads/.
 *
 * With neither (e.g. Vercel without Supabase) the site shows the built-in
 * defaults and the CMS is read-only.
 */

export const CONTENT_TAG = "site-content";
const BUCKET = "site-media";
const env = (k: string) => process.env[k]?.trim() || "";
const supabaseOn = () => Boolean(env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY"));
const localOn = () => !supabaseOn() && !process.env.VERCEL;
const isPreviewExport = () => process.env.UNIBEE_PREVIEW_EXPORT === "1";

export type ContentBackend = "supabase" | "local-file" | "none";
export const contentBackend = (): ContentBackend => (supabaseOn() ? "supabase" : localOn() ? "local-file" : "none");

export type ContentVersion = { id: string; savedAt: string; data: SiteContent };
type Stored = { data: SiteContent; updatedAt: string | null };

const DATA_DIR = path.join(process.cwd(), ".data");
const CONTENT_FILE = path.join(DATA_DIR, "content.json");
const HISTORY_FILE = path.join(DATA_DIR, "content-history.json");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

const sbHeaders = (extra: Record<string, string> = {}) => ({
  apikey: env("SUPABASE_SERVICE_ROLE_KEY"),
  Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
  ...extra,
});

async function readStored(): Promise<Stored> {
  if (supabaseOn()) {
    const res = await fetch(`${env("SUPABASE_URL")}/rest/v1/site_content?id=eq.main&select=data,updated_at`, {
      headers: sbHeaders(),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Supabase content read failed: ${res.status}`);
    const rows = (await res.json()) as { data: unknown; updated_at: string }[];
    return rows[0] ? { data: normalizeContent(rows[0].data), updatedAt: rows[0].updated_at } : { data: defaultContent, updatedAt: null };
  }
  if (localOn()) {
    try {
      const raw = JSON.parse(await fs.readFile(CONTENT_FILE, "utf8")) as { data: unknown; updatedAt: string };
      return { data: normalizeContent(raw.data), updatedAt: raw.updatedAt };
    } catch {
      return { data: defaultContent, updatedAt: null };
    }
  }
  return { data: defaultContent, updatedAt: null };
}

const cachedContent = unstable_cache(
  async () => {
    try {
      return (await readStored()).data;
    } catch (err) {
      console.error("[content] read failed, using defaults", err);
      return defaultContent;
    }
  },
  ["site-content-v1"],
  { tags: [CONTENT_TAG], revalidate: 3600 },
);

/** Content for the public site (cached; refreshed instantly when the CMS saves). */
export async function getContent(): Promise<SiteContent> {
  if (isPreviewExport()) return defaultContent;
  return cachedContent();
}

/** Uncached read for the CMS, with the last-saved time. */
export async function getContentForEditing(): Promise<Stored> {
  return readStored();
}

export async function listVersions(limit = 15): Promise<ContentVersion[]> {
  if (supabaseOn()) {
    const res = await fetch(
      `${env("SUPABASE_URL")}/rest/v1/site_content_history?select=id,data,saved_at&order=saved_at.desc&limit=${limit}`,
      { headers: sbHeaders(), cache: "no-store" },
    );
    if (!res.ok) return [];
    return ((await res.json()) as { id: number; data: unknown; saved_at: string }[]).map((r) => ({
      id: String(r.id),
      savedAt: r.saved_at,
      data: normalizeContent(r.data),
    }));
  }
  if (localOn()) {
    try {
      const rows = JSON.parse(await fs.readFile(HISTORY_FILE, "utf8")) as ContentVersion[];
      return rows.slice(0, limit).map((r) => ({ ...r, data: normalizeContent(r.data) }));
    } catch {
      return [];
    }
  }
  return [];
}

/** Saves content (after cleaning it), keeps a version, and refreshes every page. */
export async function saveContent(input: unknown): Promise<Stored> {
  const data = normalizeContent(input);
  const savedAt = new Date().toISOString();

  if (supabaseOn()) {
    const base = env("SUPABASE_URL");
    const res = await fetch(`${base}/rest/v1/site_content`, {
      method: "POST",
      headers: sbHeaders({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ id: "main", data, updated_at: savedAt }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Supabase content save failed: ${res.status} ${await res.text()}`);
    // Version history is best-effort: a failure here shouldn't block the save.
    await fetch(`${base}/rest/v1/site_content_history`, {
      method: "POST",
      headers: sbHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify({ data, saved_at: savedAt }),
      cache: "no-store",
    }).catch((e) => console.error("[content] history save failed", e));
  } else if (localOn()) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(CONTENT_FILE, JSON.stringify({ data, updatedAt: savedAt }, null, 2));
    let history: ContentVersion[] = [];
    try {
      history = JSON.parse(await fs.readFile(HISTORY_FILE, "utf8"));
    } catch {
      /* first save */
    }
    history.unshift({ id: crypto.randomUUID(), savedAt, data });
    await fs.writeFile(HISTORY_FILE, JSON.stringify(history.slice(0, 30)));
  } else {
    throw new Error("Saving needs Supabase: add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }

  revalidateTag(CONTENT_TAG);
  revalidatePath("/", "layout");
  return { data, updatedAt: savedAt };
}

/* ───────── Uploaded images ───────── */

export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Detects the real image type from the file's first bytes (the browser's claim isn't trusted). */
export function sniffImageType(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp" && /avi[fs]/.test(b.toString("ascii", 8, 12))) return "image/avif";
  return null;
}

/** Stores an image and returns its public URL. SVG is not accepted (it can carry scripts). */
export async function saveImage(bytes: Buffer, originalName: string): Promise<string> {
  const type = sniffImageType(bytes) ?? "";
  const ext = ALLOWED_IMAGE_TYPES[type];
  if (!ext) throw new Error("Please upload a JPG, PNG, WebP or AVIF image.");
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Image is too large (max 5 MB).");
  const base = path.parse(originalName).name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "image";
  const name = `${base}-${crypto.randomBytes(4).toString("hex")}.${ext}`;

  if (supabaseOn()) {
    const res = await fetch(`${env("SUPABASE_URL")}/storage/v1/object/${BUCKET}/${name}`, {
      method: "POST",
      headers: sbHeaders({ "Content-Type": type, "x-upsert": "false", "Cache-Control": "31536000" }),
      body: new Uint8Array(bytes),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
    return `${env("SUPABASE_URL")}/storage/v1/object/public/${BUCKET}/${name}`;
  }
  if (localOn()) {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.writeFile(path.join(UPLOAD_DIR, name), bytes);
    return `/media/${name}`;
  }
  throw new Error("Uploading needs Supabase: add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
}
