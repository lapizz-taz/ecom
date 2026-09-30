/**
 * Seeds the knowledge base + default settings from /data and creates the first admin.
 * Safe to re-run: existing entries/settings edited in the dashboard are NOT overwritten.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_INITIAL_PASSWORD='...' npm run db:seed
 */
import { PrismaClient, type KnowledgeCategory } from "@prisma/client";
import bcrypt from "bcryptjs";
import brand from "../data/brand/brand.json";
import policies from "../data/policies/policies.json";
import faq from "../data/faq/faq.json";
import promotions from "../data/promotions/promotions.json";
import defaults from "../data/settings/defaults.json";

const prisma = new PrismaClient();

async function upsertEntry(category: KnowledgeCategory, key: string, title: string, content: string | null) {
  const existing = await prisma.knowledgeEntry.findUnique({ where: { key } });
  if (existing) return false;
  await prisma.knowledgeEntry.create({ data: { category, key, title, content: content ?? "", updatedBy: "seed" } });
  return true;
}

async function main() {
  let created = 0;
  const b = brand as typeof brand;
  created += +(await upsertEntry("BRAND", "brand.business-model", "Business model", b.businessModel));
  created += +(await upsertEntry("BRAND", "brand.description", "About Isolation", b.description));
  created += +(await upsertEntry("BRAND", "brand.categories", "Product categories Isolation sells", b.productCategories.join(", ")));
  created += +(await upsertEntry("BRAND", "brand.instagram", "Instagram", b.instagram));
  created += +(await upsertEntry("BRAND", "brand.website", "Website", b.website));

  for (const p of policies.policies) created += +(await upsertEntry("POLICY", p.key, p.title, p.content));
  for (const f of faq.faqs) created += +(await upsertEntry("FAQ", f.key, f.question, f.answer));
  for (const p of promotions.promotions as { key: string; title: string; details: string }[]) {
    created += +(await upsertEntry("PROMOTION", p.key, p.title, p.details));
  }

  for (const [key, value] of Object.entries(defaults)) {
    const exists = await prisma.setting.findUnique({ where: { key } });
    if (!exists) await prisma.setting.create({ data: { key, value: value as object, updatedBy: "seed" } });
  }

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_INITIAL_PASSWORD;
  const admins = await prisma.adminUser.count({ where: { role: "ADMIN" } });
  if (admins === 0) {
    if (!email || !password) {
      console.log("⚠️  No admin user yet. Set ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD and re-run `npm run db:seed` (or use `npm run admin:create`).");
    } else if (password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
      console.log("⚠️  ADMIN_INITIAL_PASSWORD needs 12+ characters with upper-case, lower-case and a number — admin not created.");
    } else {
      await prisma.adminUser.create({ data: { email, name: "Owner", role: "ADMIN", passwordHash: await bcrypt.hash(password, 12) } });
      console.log(`✅ Admin user created: ${email} (you can now remove ADMIN_INITIAL_PASSWORD from your environment)`);
    }
  }
  console.log(`✅ Seed complete — ${created} knowledge entries created.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
