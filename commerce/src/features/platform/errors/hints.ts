// Likely causes for an error, from what its message says. An automatic first guess to start
// from, never a verdict: the steps, the stack and the request on the other side tell the rest.

export interface ErrorHint { title: string; cause: string; fix: string }

interface Facts { message: string; category: string; source: string; status?: string; regressed_at?: string | null; old_version_hits?: number }

type Rule = { test: RegExp; also?: RegExp; hint: (m: RegExpExecArray) => ErrorHint }

const COURIERS = /pathao|steadfast|redx|carrybee/i

const RULES: Rule[] = [
  {
    test: /inbox_channels_one_store/i,
    hint: () => ({
      title: 'Page already connected to another business',
      cause: 'The Facebook Page or Instagram account is connected to another Fullfilio business; it can only be in one at a time.',
      fix: 'The person is told to disconnect it in the other business first. Only a code issue if that message did not show.',
    }),
  },
  {
    test: /duplicate key value violates unique constraint "?([a-z0-9_]+)/i,
    hint: (m) => ({
      title: `Saved twice (${m[1]})`,
      cause: 'The same record was written twice: a double click or a retry, two requests at the same moment, or an import meeting a row that already exists.',
      fix: 'Find the save in the steps and make it safe to repeat (insert … on conflict, or check first), or disable the button while it saves.',
    }),
  },
  {
    test: /(?:function|procedure) ([\w.]+)\(.*?\) does not exist|Could not find the function ([\w.]+)|PGRST202/i,
    hint: (m) => ({
      title: `Database function missing${m[1] || m[2] ? `: ${m[1] || m[2]}` : ''}`,
      cause: 'The app calls a database function the live database does not have: the migration that adds it was not run, or its arguments changed.',
      fix: 'Run the matching migration in the Supabase SQL Editor (or publish the app version that matches the database).',
    }),
  },
  {
    test: /column "?([\w.]+)"? (?:of relation "?\w+"? )?does not exist|Could not find the '([\w]+)' column|PGRST204/i,
    hint: (m) => ({
      title: `Column missing${m[1] || m[2] ? `: ${m[1] || m[2]}` : ''}`,
      cause: 'A query names a column the live database does not have: a migration was not run, or the code expects a newer database.',
      fix: 'Run the migration that adds the column, or correct the column name in the code.',
    }),
  },
  {
    test: /relation "?([\w.]+)"? does not exist|Could not find the table '?([\w.]+)|PGRST205/i,
    hint: (m) => ({
      title: `Table missing${m[1] || m[2] ? `: ${m[1] || m[2]}` : ''}`,
      cause: 'A query names a table the live database does not have: the migration that creates it was not run.',
      fix: 'Run the migration that creates the table in the Supabase SQL Editor.',
    }),
  },
  {
    test: /permission denied for (table|function|schema|sequence|view) ([\w.]+)/i,
    hint: (m) => ({
      title: `Database permission missing (${m[1]} ${m[2]})`,
      cause: 'A new table or function has no grant for the role that calls it, or a business function is not owned by app_owner.',
      fix: 'Add the grant (or alter … owner to app_owner) in a migration. Never widen access to make it pass.',
    }),
  },
  {
    test: /row-level security/i,
    hint: () => ({
      title: 'Refused by the business separation rules',
      cause: 'A write named another business (wrong merchant_id) or happened in a read-only support view.',
      fix: 'Check which business the row belongs to and that the function runs as the signed-in business.',
    }),
  },
  {
    test: /null value in column "?(\w+)"?(?: of relation "?(\w+)"?)? violates not-null/i,
    hint: (m) => ({
      title: `Required value missing: ${m[1]}${m[2] ? ` (${m[2]})` : ''}`,
      cause: `Something was saved without "${m[1]}": a form or import left it empty, or a function forgot to fill it.`,
      fix: 'Validate it before saving with a clear message, or fill it in the function.',
    }),
  },
  {
    test: /violates foreign key constraint "?(\w+)/i,
    hint: (m) => ({
      title: `Linked record missing or still in use (${m[1]})`,
      cause: 'A row points to a record that does not exist, or a record that others still point to was deleted.',
      fix: 'Check the order of saves and deletes; delete or move the dependent rows first.',
    }),
  },
  {
    test: /violates check constraint "?(\w+)/i,
    hint: (m) => ({
      title: `Value not allowed (${m[1]})`,
      cause: 'A value outside what the database allows was saved (an unknown status, a negative amount, a text too long).',
      fix: 'Validate the value in the form or function, or widen the check in a migration if the value is right.',
    }),
  },
  {
    test: /statement timeout|canceling statement due to/i,
    hint: () => ({
      title: 'Database query too slow',
      cause: 'A query ran longer than allowed: a large table without a fitting index, or a report over a long period.',
      fix: 'Find the query from the steps (the rpc or read just before), add an index or narrow it.',
    }),
  },
  {
    test: /deadlock detected|could not serialize access/i,
    hint: () => ({
      title: 'Two changes at the same moment',
      cause: 'Two requests changed the same rows in a different order at the same time.',
      fix: 'Usually safe to retry; if it repeats, lock rows in a fixed order.',
    }),
  },
  {
    test: /JWT expired|invalid JWT|jwt malformed|SESSION_EXPIRED|sign-in (?:has )?expired/i,
    hint: () => ({
      title: 'Sign-in expired',
      cause: 'The person\'s sign-in ended while the page was open.',
      fix: 'Usually harmless (the app renews it). If it repeats for one person, check their device clock and sign-in.',
    }),
  },
  {
    test: /Too many subrequests/i,
    hint: () => ({
      title: 'Cloudflare Worker limit: too many outgoing calls',
      cause: 'One request made more outgoing calls than a Worker may.',
      fix: 'Batch the calls, or split the work over several requests (pages).',
    }),
  },
  {
    test: /exceeded (?:its )?CPU|Worker exceeded|never generate a response|Error 1102/i,
    hint: () => ({
      title: 'Cloudflare Worker limit: too much work in one request',
      cause: 'The request used more CPU time than a Worker may.',
      fix: 'Do less per request (smaller pages), or move the heavy part to the database or a background job.',
    }),
  },
  {
    test: /OAuthException|Error validating access token|"code":\s*190\b|\(#190\)|session has been invalidated/i,
    hint: () => ({
      title: 'Meta token no longer valid',
      cause: 'The Page or account token was cancelled (password change, access removed, app removed) or expired.',
      fix: 'The business reconnects the Page in Messaging → Channels. Nothing to fix in code.',
    }),
  },
  {
    test: /\(#368\)|temporarily blocked/i,
    hint: () => ({
      title: 'Meta blocked the action for a while',
      cause: 'Meta\'s spam protection blocked sending from this Page for a while.',
      fix: 'Wait; send less in bursts. Nothing to fix in code.',
    }),
  },
  {
    test: /\(#(?:4|17|32|613)\)|Application request limit|User request limit|rate limit|too many requests|\b429\b/i,
    hint: () => ({
      title: 'Rate limit',
      cause: 'The outside service (Meta, a courier, SMS) answered "too many requests".',
      fix: 'Slow down or retry later with a pause; spread bulk work over time.',
    }),
  },
  {
    test: /\(#(?:10|200|230|294)\)|requires .*permission|does not have permission|Permissions error/i,
    hint: () => ({
      title: 'Meta permission missing',
      cause: 'The app lacks the Meta permission this call needs (App Review pending or not granted), or the Page did not give it.',
      fix: 'Check the permission in the Meta app review; the business may need to reconnect and allow it.',
    }),
  },
  {
    test: /\b40[13]\b|unauthori[sz]ed|invalid (?:credentials|api key|token|client)|authentication failed/i,
    also: COURIERS,
    hint: () => ({
      title: 'Courier rejected the business\'s credentials',
      cause: 'The courier account details saved for this business are wrong or expired.',
      fix: 'The business updates them in Settings → Couriers. Nothing to fix in code.',
    }),
  },
  {
    test: /\b5\d\d\b|timed? ?out|unavailable|bad gateway/i,
    also: COURIERS,
    hint: () => ({
      title: 'Courier service down or slow',
      cause: 'The courier\'s system did not answer properly.',
      fix: 'Retry later (System Health has Retry for failed work). Only a code issue if it never recovers.',
    }),
  },
  {
    test: /bkash|paystation|sslcommerz/i,
    hint: () => ({
      title: 'Payment provider',
      cause: 'The payment provider refused or did not answer.',
      fix: 'Check the provider\'s answer in the context; check the merchant\'s payment settings and the provider\'s status.',
    }),
  },
  {
    test: /ETIMEDOUT|ECONNRESET|timed? ?out|AbortError|operation was aborted/i,
    hint: () => ({
      title: 'Outside service too slow',
      cause: 'A call to another service took too long or the connection dropped.',
      fix: 'Usually temporary. If it repeats, add a retry with a pause or a longer time limit.',
    }),
  },
  {
    test: /Failed to fetch|NetworkError|Load failed|ERR_NETWORK|ERR_INTERNET_DISCONNECTED/i,
    hint: () => ({
      title: 'Network problem on the person\'s device',
      cause: 'The browser could not reach the server (weak mobile data, Wi-Fi drop).',
      fix: 'Nothing to fix unless many people see it at once (then check System Health).',
    }),
  },
  {
    test: /dynamically imported module|Loading chunk|Importing a module script failed/i,
    hint: () => ({
      title: 'Old app open after an update',
      cause: 'The tab still ran the previous version after a publish, and its code files were replaced.',
      fix: 'The app reloads itself. Nothing to fix unless it repeats on fresh tabs.',
    }),
  },
  {
    test: /Maximum update depth exceeded|Too many re-renders/i,
    hint: () => ({
      title: 'Screen stuck in a loop',
      cause: 'A screen kept updating itself (a state change inside render or an effect without the right dependencies).',
      fix: 'Open the component in the stack and fix the effect or state update.',
    }),
  },
  {
    test: /Cannot read propert(?:y|ies) of (?:undefined|null)|undefined is not an object|null is not an object|is not a function|is not iterable|Cannot destructure/i,
    hint: () => ({
      title: 'Code bug: a value was missing',
      cause: 'The screen used data that was not there: a field the server did not send, sent as null, or not loaded yet.',
      fix: 'Open the stack and the page in the steps; guard the value or fix the server\'s answer. Copy for Claude for a fix.',
    }),
  },
  {
    test: /QuotaExceededError|localStorage|sessionStorage/i,
    hint: () => ({
      title: 'Browser storage full or blocked',
      cause: 'The browser refused to save (private mode, storage full).',
      fix: 'The code should go on without storage: wrap the read or write in try/catch.',
    }),
  },
  {
    test: /"Something went wrong[^"]*" shown/i,
    hint: () => ({
      title: 'A general error message was shown',
      cause: 'The person saw "Something went wrong". The call that failed is named in the message.',
      fix: 'Open "Same request" below for the server\'s real error, or the steps for the failing call.',
    }),
  },
]

const BY_CATEGORY: Record<string, ErrorHint> = {
  FRONTEND: { title: 'A screen failed', cause: 'An error in the admin or panel code in the browser.', fix: 'Read the stack and the steps before it; Copy for Claude for a fix.' },
  FUNCTION: { title: 'A server function failed', cause: 'An error inside a backend function.', fix: 'Read the message and stack; the browser\'s side is under "Same request" when there is one.' },
  WEBHOOK: { title: 'An incoming webhook failed', cause: 'A message from Shopify, WooCommerce, a courier or Meta could not be processed.', fix: 'Check the context for the sender and payload; the sender usually retries.' },
  JOB: { title: 'A scheduled task failed', cause: 'A background job raised an error.', fix: 'System Health → Scheduled tasks shows its runs; read the message.' },
  COURIER: { title: 'A courier call failed', cause: 'Booking or tracking with a courier failed.', fix: 'Check the courier\'s answer in the context.' },
  META: { title: 'A Meta call failed', cause: 'Facebook, Instagram or WhatsApp refused or failed.', fix: 'Check Meta\'s error code in the message.' },
  SMS: { title: 'An SMS failed', cause: 'The SMS gateway refused or failed.', fix: 'Check the gateway answer and the business\'s credits.' },
  PAYMENT: { title: 'A payment call failed', cause: 'A payment provider refused or failed.', fix: 'Check the provider\'s answer in the context.' },
}

/** The likely causes, most specific first (at most two), plus what the error's history says. */
export function errorHints(e: Facts): ErrorHint[] {
  const text = `${e.message} ${e.source}`
  const out: ErrorHint[] = []
  for (const r of RULES) {
    const m = r.test.exec(text)
    if (m && (!r.also || r.also.test(text))) out.push(r.hint(m))
    if (out.length === 2) break
  }
  if (!out.length && BY_CATEGORY[e.category]) out.push(BY_CATEGORY[e.category])
  if (e.regressed_at && (e.status === 'NEW' || e.status === 'INVESTIGATING')) {
    out.push({
      title: 'It came back after being fixed',
      cause: 'The fix did not cover every path, or a later change brought it back.',
      fix: 'Compare the app version of the newest occurrence with "fixed in", and the steps with the ones before the fix.',
    })
  }
  if (e.status === 'FIXED' && (e.old_version_hits ?? 0) > 0) {
    out.push({
      title: 'Still seen in tabs not reloaded since the fix',
      cause: 'Some people kept a tab open on the version before the fix.',
      fix: 'Nothing to do: it stops when they reload. It counts here, without reopening the error.',
    })
  }
  return out
}

/** Where in the code to start: the function for server errors, the screen for browser errors. */
export function codePointer(e: { category: string; source: string }, path?: string): string | null {
  if (['FUNCTION', 'WEBHOOK', 'COURIER', 'META', 'SMS', 'PAYMENT', 'AUTH', 'FRAUD'].includes(e.category) && /^[a-z0-9-]+$/.test(e.source)) {
    return `supabase/functions/${e.source}/ (and supabase/functions/_shared/)`
  }
  if (e.category === 'FRONTEND' && path) {
    const page = path.replace(/^\/(admin|super-admin)\/?/, '').split('/').filter((p) => p && !/^[0-9a-f-]{8,}$|^\d+$/i.test(p))
    return `${path.startsWith('/super-admin') ? 'src/pages/super-admin/' : 'src/pages/admin/'}${page.join('-') || '(home)'} (page ${path})`
  }
  if (e.category === 'JOB') return `supabase/migrations (database job "${e.source}")`
  return null
}
