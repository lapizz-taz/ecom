// What a gateway answers is kept with the payment for the platform team to
// investigate. Before it is stored, the payer's phone number is cut to its last
// three digits and anything that looks like a token or secret is removed.

const SECRET_KEY = /token|secret|password|authorization|app_key|appkey|signature/i
const PHONE_KEY = /msisdn|phone|mobile|payer|customer_?number|account_?number|wallet/i

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '')
  return digits.length >= 6 ? `•••${digits.slice(-3)}` : '•••'
}

export function redactGatewayAnswer(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) return value ?? null
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactGatewayAnswer(v, depth + 1))
  if (typeof value !== 'object') return typeof value === 'string' && value.length > 2000 ? `${value.slice(0, 2000)}…` : value
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) continue
    out[key] = PHONE_KEY.test(key) && (typeof v === 'string' || typeof v === 'number') ? maskPhone(String(v)) : redactGatewayAnswer(v, depth + 1)
  }
  return out
}
