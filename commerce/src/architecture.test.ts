import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guards the layering described in docs/ARCHITECTURE.md, so it stays true as
// the code grows.

const SRC = join(__dirname)

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

const rel = (path: string) => relative(SRC, path).replace(/\\/g, '/')

describe('architecture', () => {
  it('screens, components and hooks reach the database only through src/services', () => {
    const ui = ['pages', 'features', 'components', 'layouts', 'hooks'].flatMap((d) => files(join(SRC, d)))
    const offenders = ui.filter((f) => /\bsupabase\s*\.\s*(from|rpc|functions|storage)\s*\(/.test(readFileSync(f, 'utf8'))).map(rel)
    expect(offenders).toEqual([])
  })

  it('reads build-time configuration only in src/lib/env.ts', () => {
    const offenders = files(SRC).filter((f) => rel(f) !== 'lib/env.ts' && readFileSync(f, 'utf8').includes('import.meta.env')).map(rel)
    expect(offenders).toEqual([])
  })

  it('services do not import UI code', () => {
    const offenders = files(join(SRC, 'services')).filter((f) => /from '@\/(pages|features|components|layouts)\//.test(readFileSync(f, 'utf8'))).map(rel)
    expect(offenders).toEqual([])
  })

  it("takes today's date from the local calendar (isoDate), not from UTC", () => {
    // toISOString() is the UTC date: from midnight to 6 AM in Bangladesh that is still yesterday. These
    // only do arithmetic on date strings already in UTC, or read dates a library gives in UTC.
    const utcOnPurpose = ['features/hr/attendance.tsx', 'features/hr/review.tsx', 'features/couriers/statement-parse.ts']
    const offenders = files(SRC).filter((f) => !utcOnPurpose.includes(rel(f)) && readFileSync(f, 'utf8').includes('toISOString().slice(0, 10)')).map(rel)
    expect(offenders).toEqual([])
  })

  it('names files in kebab-case', () => {
    const offenders = files(SRC).map(rel).filter((f) => !/^([a-z0-9]+(-[a-z0-9]+)*\/)*[a-z0-9]+(-[a-z0-9]+)*(\.d)?\.tsx?$/.test(f) && f !== 'App.tsx')
    expect(offenders).toEqual([])
  })

  it('admin colours leave dark mode to the theme (no dark: override of a shade the theme already flips)', () => {
    // index.css re-maps tinted shades under .dark: light shades become dark tints, dark shades
    // readable text. A dark:text-amber-200 or dark:bg-amber-950 written for the stock palette is
    // flipped twice there and comes out dark text on a light tint. Toasts are a deliberate light
    // card; customer pages never run under .dark. Greys are re-mapped unevenly (zinc-800 stays dark)
    // and are not covered here.
    const dark = readFileSync(join(SRC, 'index.css'), 'utf8').match(/\.dark\s*\{([^}]*)\}/)?.[1] ?? ''
    const flipped = new Set([...dark.matchAll(/--color-([a-z]+)-(\d+):/g)]
      .filter((m) => !['zinc', 'gray', 'slate', 'neutral', 'stone'].includes(m[1])).map((m) => `${m[1]}-${m[2]}`))
    expect(flipped.size).toBeGreaterThan(50)
    const skip = (f: string) => f === 'lib/toast.tsx' || f.startsWith('pages/customer/')
    const offenders = files(SRC).filter((f) => !skip(rel(f))).flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/dark:(text|bg|border|ring)-([a-z]+)-(\d+)/g)]
        .filter(([, prop, hue, shade]) => flipped.has(`${hue}-${shade}`)
          && (prop === 'text' ? Number(shade) <= 300 : Number(shade) >= 600))
        .map((m) => `${rel(f)}: ${m[0]}`))
    expect(offenders).toEqual([])
  })
})
