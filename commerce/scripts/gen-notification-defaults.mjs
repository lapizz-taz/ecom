// Prints the SQL that stores the default customer emails and WhatsApp texts
// (supabase/functions/_shared/notifications/defaults.ts) in public.notification_defaults.
// Used to write the Email & WhatsApp migration; a unit test keeps the two equal.
//   node --experimental-strip-types scripts/gen-notification-defaults.mjs
import { EMAIL_DEFAULTS, MESSAGE_EVENTS, WHATSAPP_DEFAULTS } from '../supabase/functions/_shared/notifications/defaults.ts'

const q = (s) => {
  if (s.includes('$t$')) throw new Error('a default contains $t$')
  return `$t$${s}$t$`
}
const rows = []
for (const e of MESSAGE_EVENTS) rows.push(`  ('EMAIL', '${e}', ${q(EMAIL_DEFAULTS[e].subject)}, ${q(EMAIL_DEFAULTS[e].template)})`)
for (const e of MESSAGE_EVENTS) rows.push(`  ('WHATSAPP', '${e}', null, ${q(WHATSAPP_DEFAULTS[e])})`)
process.stdout.write(`insert into public.notification_defaults (channel, event, subject, template) values
${rows.join(',\n')}
on conflict (channel, event) do update set subject = excluded.subject, template = excluded.template;
`)
