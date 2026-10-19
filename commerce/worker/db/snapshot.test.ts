import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ES module script
import { migrationsHash } from '../../scripts/pg-sqlite/migrations-hash.mjs'

describe('Cloudflare schema snapshot', () => {
  it('was made from the current migrations (run `npm run db:convert` after adding one)', () => {
    const source = JSON.parse(readFileSync(resolve(import.meta.dirname, 'generated', 'source.json'), 'utf8'))
    expect(source).toEqual(migrationsHash())
  })
})
