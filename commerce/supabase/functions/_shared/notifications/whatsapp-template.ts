// WhatsApp message templates: what Meta accepts, and how a text written with named placeholders
// ({{customer_first_name}}, as in SMS) becomes Meta's numbered ones ({{1}}, {{2}} …). Used by the
// editor (to warn before submitting) and by the backend (to submit and to send).
import { WHATSAPP_VARIABLES } from './defaults.ts'

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g
const KNOWN = new Set(WHATSAPP_VARIABLES.map((v) => v.name))
export const WHATSAPP_MAX_BODY = 1024

/** Problems Meta would reject the text for (or that would send badly), in plain words. Empty: fine. */
export function whatsappProblems(body: string): string[] {
  const text = body.trim()
  const problems: string[] = []
  if (!text) return ['Write the message.']
  if (text.length > WHATSAPP_MAX_BODY) problems.push(`WhatsApp allows up to ${WHATSAPP_MAX_BODY} characters (this has ${text.length}).`)
  const names = [...text.matchAll(PLACEHOLDER)].map((m) => m[1])
  const unknown = [...new Set(names.filter((n) => !KNOWN.has(n)))]
  if (unknown.length) problems.push(`Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((n) => `{{${n}}}`).join(', ')}.`)
  if (/\{\{(?![\s]*[a-z_]+\s*\}\})|(?<!\{\{\s*[a-z_]+\s*)\}\}/.test(text)) problems.push('A placeholder is not written as {{name}}.')
  if (/^\{\{/.test(text)) problems.push('Start the message with words, not a placeholder (Meta rule).')
  if (/\{\{\s*[a-z_]+\s*\}\}[\s.,!?:;)]*$/.test(text)) problems.push('End the message with words, not a placeholder (Meta rule).')
  if (/\}\}\s*\{\{/.test(text)) problems.push('Put words between two placeholders (Meta rule).')
  const words = text.replace(PLACEHOLDER, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  if (names.length && words < names.length * 2) problems.push('Too many placeholders for a message this short: add more words (Meta rule).')
  if (/\n{3,}/.test(text)) problems.push('Use at most one empty line between paragraphs.')
  return problems
}

/** The text as Meta stores it ({{1}}, {{2}} …) and the placeholder name behind each number. */
export function toPositional(body: string): { text: string; params: string[] } {
  const params: string[] = []
  const text = body.trim().replace(PLACEHOLDER, (_, name: string) => {
    params.push(name)
    return `{{${params.length}}}`
  })
  return { text, params }
}

/** Example values Meta asks for when a template has placeholders. */
export function exampleValues(params: string[]): string[] {
  const byName = new Map(WHATSAPP_VARIABLES.map((v) => [v.name, v.example]))
  return params.map((p) => byName.get(p) ?? 'example')
}

/** Meta template name: lower case, digits and _ only, unique per business account and language. */
export function templateName(event: string, version: number): string {
  return `ff_${event.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_v${Math.max(1, Math.trunc(version))}`.slice(0, 512)
}

/** A value as WhatsApp takes it in a template: no line breaks or tabs, no long runs of spaces, never empty. */
export function paramValue(v: unknown): string {
  const s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim()
  return (s || '-').slice(0, 1000)
}

/** The text with values filled in (for previews and the manual "Send on WhatsApp" link). */
export function fillWhatsapp(body: string, values: Record<string, unknown>): string {
  return body.replace(PLACEHOLDER, (_, name: string) => String(values[name] ?? ''))
}
