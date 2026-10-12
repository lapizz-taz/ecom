import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { COLUMNS, type RegistrationRecord } from "@/lib/registration";

/**
 * Where registrations are saved. Configure one (or both) in your environment:
 *
 *  • Google Sheet: GOOGLE_SHEETS_WEBHOOK_URL + GOOGLE_SHEETS_SECRET
 *    (deploy docs/google-sheets-apps-script.js as a Web App; see README)
 *  • Supabase:     SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *    (run docs/supabase-schema.sql once; see README)
 *
 * With neither configured, local development saves to .data/registrations.json.
 */

type Store = {
  name: string;
  save(record: RegistrationRecord): Promise<void>;
  list(): Promise<RegistrationRecord[]>;
};

const env = (k: string) => process.env[k]?.trim() || "";

function normalise(row: Record<string, unknown>): RegistrationRecord {
  const out = {} as RegistrationRecord;
  for (const [key] of COLUMNS) out[key] = row[key] == null ? "" : String(row[key]);
  return out;
}

const supabase: Store = {
  name: "supabase",
  async save(record) {
    const res = await fetch(`${env("SUPABASE_URL")}/rest/v1/registrations`, {
      method: "POST",
      headers: {
        apikey: env("SUPABASE_SERVICE_ROLE_KEY"),
        Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(record),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Supabase insert failed: ${res.status} ${await res.text()}`);
  },
  async list() {
    const res = await fetch(
      `${env("SUPABASE_URL")}/rest/v1/registrations?select=*&order=created_at.desc&limit=10000`,
      {
        headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}` },
        cache: "no-store",
      },
    );
    if (!res.ok) throw new Error(`Supabase list failed: ${res.status}`);
    return ((await res.json()) as Record<string, unknown>[]).map(normalise);
  },
};

const sheets: Store = {
  name: "google-sheets",
  async save(record) {
    const res = await fetch(env("GOOGLE_SHEETS_WEBHOOK_URL"), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // Apps Script reads e.postData.contents
      body: JSON.stringify({ secret: env("GOOGLE_SHEETS_SECRET"), action: "append", columns: COLUMNS.map((c) => c[1]), keys: COLUMNS.map((c) => c[0]), record }),
      redirect: "follow",
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok || !text.includes('"ok":true')) throw new Error(`Google Sheets append failed: ${res.status} ${text.slice(0, 200)}`);
  },
  async list() {
    const url = new URL(env("GOOGLE_SHEETS_WEBHOOK_URL"));
    url.searchParams.set("secret", env("GOOGLE_SHEETS_SECRET"));
    url.searchParams.set("action", "list");
    const res = await fetch(url, { redirect: "follow", cache: "no-store" });
    const data = (await res.json()) as { ok: boolean; rows?: Record<string, unknown>[] };
    if (!data.ok) throw new Error("Google Sheets list failed");
    return (data.rows ?? []).map(normalise).sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
};

const LOCAL_FILE = path.join(process.cwd(), ".data", "registrations.json");
const localFile: Store = {
  name: "local-file",
  async save(record) {
    const rows = await this.list();
    rows.unshift(record);
    await fs.mkdir(path.dirname(LOCAL_FILE), { recursive: true });
    await fs.writeFile(LOCAL_FILE, JSON.stringify(rows, null, 2));
  },
  async list() {
    try {
      return (JSON.parse(await fs.readFile(LOCAL_FILE, "utf8")) as Record<string, unknown>[]).map(normalise);
    } catch {
      return [];
    }
  },
};

export function configuredStores(): Store[] {
  const stores: Store[] = [];
  if (env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY")) stores.push(supabase);
  if (env("GOOGLE_SHEETS_WEBHOOK_URL") && env("GOOGLE_SHEETS_SECRET")) stores.push(sheets);
  // Local file only outside Vercel (Vercel's file system is read-only/ephemeral).
  if (stores.length === 0 && !process.env.VERCEL) stores.push(localFile);
  return stores;
}

/** Saves to every configured store. Succeeds if at least one store saved it. */
export async function saveRegistration(record: RegistrationRecord): Promise<string[]> {
  const stores = configuredStores();
  if (stores.length === 0) throw new Error("No storage configured: set Google Sheets or Supabase environment variables.");
  const results = await Promise.allSettled(stores.map((s) => s.save(record)));
  const saved = stores.filter((_, i) => results[i].status === "fulfilled").map((s) => s.name);
  results.forEach((r, i) => r.status === "rejected" && console.error(`[register] ${stores[i].name}:`, r.reason));
  if (saved.length === 0) throw new Error("Could not save the registration to any store.");
  return saved;
}

/** Reads registrations for the admin page (Supabase preferred, then Sheets, then local). */
export async function listRegistrations(): Promise<{ rows: RegistrationRecord[]; source: string }> {
  const [store] = configuredStores();
  if (!store) return { rows: [], source: "none" };
  return { rows: await store.list(), source: store.name };
}
