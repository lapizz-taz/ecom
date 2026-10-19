import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SCRIPT = 'public/downloads/root-proxy/install.sh'

/** The directive lines of a Caddyfile: comments, blank lines and indentation dropped. */
const directives = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))

describe('root-domain proxy install script', () => {
  const script = readFileSync(SCRIPT, 'utf8')
  const embedded = (start: string) => script.slice(script.indexOf(start) + start.length, script.indexOf('\nEOF', script.indexOf(start)))

  it('is valid bash', () => {
    expect(() => execFileSync('bash', ['-n', SCRIPT], { stdio: 'pipe' })).not.toThrow()
  })

  it('writes the same Caddyfile and compose file as deploy/root-proxy', () => {
    expect(directives(embedded(`cat > "$DIR/Caddyfile" <<'EOF'\n`))).toEqual(directives(readFileSync('deploy/root-proxy/Caddyfile', 'utf8')))
    const compose = directives(readFileSync('deploy/root-proxy/docker-compose.yml', 'utf8'))
    expect(directives(embedded(`cat > "$DIR/docker-compose.yml" <<'EOF'\n`)).filter((l) => !l.startsWith('name:'))).toEqual(compose)
  })
})
