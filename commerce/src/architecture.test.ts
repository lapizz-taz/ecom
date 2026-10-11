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

  it('names files in kebab-case', () => {
    const offenders = files(SRC).map(rel).filter((f) => !/^([a-z0-9]+(-[a-z0-9]+)*\/)*[a-z0-9]+(-[a-z0-9]+)*(\.d)?\.tsx?$/.test(f) && f !== 'App.tsx')
    expect(offenders).toEqual([])
  })
})
