import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('WooCommerce plugin download', () => {
  it('public/downloads/fullfilio-connect.zip matches integrations/woocommerce/fullfilio-connect', () => {
    expect(() => execFileSync('node', ['scripts/build-woo-plugin.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
  })
})
