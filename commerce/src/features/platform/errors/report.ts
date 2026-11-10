// "Copy for Claude": everything about one error in one text, to paste into a Claude Code session
// on the repository so the cause can be found and fixed without going back and forth.
import type { ErrorDetail, ErrorSample } from '@/services/platform-ops'
import { codePointer, errorHints } from './hints'

const STATUS: Record<string, string> = { NEW: 'New', INVESTIGATING: 'Investigating', FIXED: 'Fixed', IGNORED: 'Ignored' }

type Step = { t?: string; at?: string; to?: string; label?: string; name?: string; status?: unknown; ms?: number; x?: number; request_id?: string; text?: string }

/** One step of the trail as a line: "06:12:07  rpc create_order → 500 (312 ms) · request a1b2c3". */
export function stepLine(s: Step): string {
  const time = s.at ? s.at.slice(11, 19) : '        '
  const what = s.t === 'nav' ? `opened ${s.to}`
    : s.t === 'click' ? `pressed "${s.label}"`
    : s.t === 'call' ? `${s.name} → ${s.status}${s.ms != null ? ` (${s.ms} ms)` : ''}${s.x ? ` ×${s.x}` : ''}${s.request_id ? ` · request ${s.request_id}` : ''}`
    : s.t === 'toast' ? `message shown: "${s.text}"`
    : s.t === 'error' ? `error: ${s.text}`
    : JSON.stringify(s)
  return `${time}  ${what}`
}

const steps = (c: Record<string, unknown>): Step[] => (Array.isArray(c.trail) ? (c.trail as Step[]) : [])

function rest(c: Record<string, unknown>): Record<string, unknown> {
  const { trail: _t, stack: _s, ...other } = c
  return other
}

const who = (s: ErrorSample) => [s.merchant ? `business #${s.merchant.number} ${s.merchant.name}` : 'no business (platform)', s.user ? `person ${s.user.id}` : null].filter(Boolean).join(', ')

export function claudeReport(d: ErrorDetail): string {
  const e = d.error
  const newest = d.samples[0]
  const ctx = (newest?.context ?? e.context ?? {}) as Record<string, unknown>
  const businesses = d.siblings.map((s) => (s.merchant ? `#${s.merchant.number} ${s.merchant.name}` : 'platform'))
  const total = d.siblings.reduce((n, s) => n + s.occurrences, 0) || e.occurrences
  const hints = errorHints({ ...e, old_version_hits: e.old_version_hits })
  const pointer = codePointer(e, typeof ctx.path === 'string' ? ctx.path : undefined)
  const lines: string[] = []
  lines.push(`Fullfilio error #${e.id}: please find the root cause and fix it (add a test that fails without the fix).`, '')
  lines.push(`What: ${e.message}`)
  lines.push(`Where: ${e.category.toLowerCase()} · ${e.source} · level ${e.level.toLowerCase()}`)
  lines.push(`Status: ${STATUS[e.status] ?? e.status}${e.regressions ? ` · came back ${e.regressions} time(s), last ${e.regressed_at}` : ''}${e.fixed_in ? ` · fixed in ${e.fixed_in}` : ''}`)
  if (e.note) lines.push(`Note: ${e.note}`)
  lines.push(`Seen: ${total} time(s), first ${e.first_seen_at}, last ${e.last_seen_at}, in ${businesses.length} place(s): ${businesses.slice(0, 8).join(', ')}${businesses.length > 8 ? ', …' : ''}`)
  if (e.old_version_hits) lines.push(`Since the fix: ${e.old_version_hits} time(s) from tabs on an older app version (not reloaded).`)
  lines.push(`App version (newest occurrence): ${newest?.release ?? e.last_release ?? 'not known (server)'}`)
  if (pointer) lines.push(`Start in: ${pointer}`)
  if (hints.length) {
    lines.push('', 'Likely cause (automatic first guess):')
    for (const h of hints) lines.push(`- ${h.title}: ${h.cause} ${h.fix}`)
  }
  if (newest) {
    lines.push('', `Newest occurrence: ${newest.at}, ${who(newest)}${ctx.path ? `, page ${ctx.path}` : ''}`)
    if (newest.message !== e.message) lines.push(`Message: ${newest.message}`)
    if (typeof ctx.stack === 'string' && ctx.stack) lines.push('Stack:', '```', ctx.stack, '```')
    const trail = steps(ctx)
    if (trail.length) {
      lines.push('Steps before it (oldest first, UTC):')
      for (const s of trail) lines.push(`  ${stepLine(s)}`)
    }
    const other = rest(ctx)
    if (Object.keys(other).length) lines.push('Details:', '```json', JSON.stringify(other, null, 2), '```')
  }
  if (d.linked.length) {
    lines.push('', 'Same request, other side (browser ↔ server):')
    for (const l of d.linked) {
      lines.push(`- #${l.id} ${l.category.toLowerCase()} · ${l.source}: ${l.message} (request ${l.request_id}, ${l.at})`)
      if (typeof l.context?.stack === 'string') lines.push('  Stack:', ...String(l.context.stack).split('\n').map((x) => `    ${x}`))
    }
  }
  if (d.nearby.length) {
    lines.push('', 'Other errors the same person hit within 2 minutes:')
    for (const n of d.nearby) lines.push(`- #${n.id} ${n.category.toLowerCase()} · ${n.source}: ${n.message} (${n.seconds_apart} s ${n.before ? 'before' : 'after'})`)
  }
  const variants = [...new Set(d.samples.map((s) => s.message))].filter((m) => m !== e.message).slice(0, 5)
  if (variants.length) {
    lines.push('', 'Other wordings of the same error:')
    for (const v of variants) lines.push(`- ${v}`)
  }
  const older = d.samples.slice(1, 6)
  if (older.length) {
    lines.push('', 'Earlier occurrences:')
    for (const s of older) {
      const c = s.context as Record<string, unknown>
      lines.push(`- ${s.at}, ${who(s)}${c.path ? `, page ${c.path}` : ''}${s.release ? `, version ${s.release}` : ''}${s.old_version ? ' (older version than the fix)' : ''}`)
      const last = steps(c).slice(-3)
      for (const st of last) lines.push(`    ${stepLine(st)}`)
    }
  }
  const days = d.daily.slice(-14)
  if (days.some((x) => x.n)) lines.push('', `Per day, last 14 days (oldest first): ${days.map((x) => x.n).join(' ')}`)
  return lines.join('\n')
}
