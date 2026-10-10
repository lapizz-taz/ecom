// One JSON line per event; never logs passwords or tokens.
export function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra })
  if (level === 'error') console.error(line)
  else console.log(line)
}
