// Prints the SQL that loads the default customer messages
// (supabase/functions/_shared/notifications/defaults.ts) — emails, WhatsApp texts and SMS in
// English and Bangla, and the owner's daily summary email — into pg_temp._nd_new, from where the
// messaging migration stores them in public.notification_defaults. A test keeps the two equal.
//   node --experimental-strip-types scripts/gen-notification-defaults.mjs
import { LANGUAGES, MESSAGE_EVENTS, messageDefaults, SUMMARY_EMAIL } from '../supabase/functions/_shared/notifications/defaults.ts'

const q = (s) => {
  if (s.includes('$t$')) throw new Error('a default contains $t$')
  return `$t$${s}$t$`
}
const rows = []
for (const lang of LANGUAGES) {
  const d = messageDefaults(lang)
  for (const e of MESSAGE_EVENTS) rows.push(`  ('EMAIL', '${e}', '${lang}', ${q(d.email[e].subject)}, ${q(d.email[e].template)})`)
  for (const e of MESSAGE_EVENTS) rows.push(`  ('WHATSAPP', '${e}', '${lang}', null, ${q(d.whatsapp[e])})`)
  for (const e of MESSAGE_EVENTS) rows.push(`  ('SMS', '${e}', '${lang}', null, ${q(d.sms[e])})`)
  rows.push(`  ('EMAIL', 'DAILY_SUMMARY', '${lang}', ${q(SUMMARY_EMAIL[lang].subject)}, ${q(SUMMARY_EMAIL[lang].template)})`)
}
process.stdout.write(`insert into pg_temp._nd_new (channel, event, language, subject, template) values
${rows.join(',\n')};
`)
