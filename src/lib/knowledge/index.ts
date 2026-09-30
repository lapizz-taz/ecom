import type { KnowledgeCategory, KnowledgeEntry } from "@prisma/client";
import { prisma } from "../db";

/**
 * Knowledge base (brand facts, policies, FAQs, promotions, extra instructions).
 * Stored in the DB so staff can edit it; seeded from /data.
 * An entry with empty content is treated as "not confirmed" — the AI must not answer from it.
 */

let cache: { rows: KnowledgeEntry[]; at: number } | null = null;
const TTL_MS = 10_000;

export async function getKnowledge(opts: { fresh?: boolean } = {}): Promise<KnowledgeEntry[]> {
  if (!opts.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const rows = await prisma.knowledgeEntry.findMany({ where: { active: true }, orderBy: { key: "asc" } });
  cache = { rows, at: Date.now() };
  return rows;
}

export function clearKnowledgeCache() {
  cache = null;
}

export async function byCategory(category: KnowledgeCategory): Promise<KnowledgeEntry[]> {
  return (await getKnowledge()).filter((r) => r.category === category && r.content.trim().length > 0);
}

export const POLICY_TOPICS = ["return", "exchange", "refund", "cancellation", "warranty", "delivery", "payment"] as const;
export type PolicyTopic = (typeof POLICY_TOPICS)[number];

export async function getPolicy(topic: PolicyTopic): Promise<{ title: string; content: string } | null> {
  const rows = await getKnowledge();
  const row = rows.find((r) => r.key === `policy.${topic}`);
  if (!row || !row.content.trim()) return null;
  return { title: row.title, content: row.content };
}

const STOP = new Set(["the", "a", "an", "is", "are", "do", "you", "i", "to", "of", "and", "or", "in", "on", "for", "what", "how", "can", "my", "me", "ki", "ta", "ache", "koto"]);

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1 && !STOP.has(w));
}

/** Simple keyword-overlap FAQ search (the catalogue is small; no vector DB needed). */
export async function searchFaq(query: string, limit = 3) {
  const faqs = await byCategory("FAQ");
  const q = new Set(tokens(query));
  if (q.size === 0) return [];
  return faqs
    .map((f) => {
      const t = tokens(`${f.title} ${f.content}`);
      const score = t.filter((w) => q.has(w)).length;
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ f }) => ({ question: f.title, answer: f.content }));
}
