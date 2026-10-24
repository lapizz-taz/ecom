import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ES module script
import { migrationsHash } from '../../scripts/pg-sqlite/migrations-hash.mjs'
import { CATALOG_READ_PERMISSIONS } from '../../scripts/pg-sqlite/translate.mjs'

const generated = (name: string) => readFileSync(resolve(import.meta.dirname, 'generated', name), 'utf8')

describe('Cloudflare schema snapshot', () => {
  it('was made from the current migrations (run `npm run db:convert` after adding one)', () => {
    const source = JSON.parse(generated('source.json'))
    expect(source).toEqual(migrationsHash())
  })

  it('reads the catalog with the same permissions as the migrations', () => {
    // The converter writes _can_read_catalog() into the product policies from its own list.
    const fn = (JSON.parse(generated('functions.json')) as Record<string, Array<{ src: string }>>)._can_read_catalog
    const codes = [...fn[0].src.matchAll(/has_permission\('([a-z_.]+)'\)/g)].map((m) => m[1])
    expect(codes.length).toBeGreaterThan(0)
    expect([...CATALOG_READ_PERMISSIONS].sort()).toEqual([...codes].sort())
  })
})
