// Packs integrations/woocommerce/fullfilio-connect into public/downloads/fullfilio-connect.zip
// (the file staff download from Sales channels → WooCommerce). Same input → same bytes:
// files are sorted and stamped with a fixed date, so the committed zip can be checked
// against the source (src/lib/woo-plugin-zip.test.ts).
//   node scripts/build-woo-plugin.mjs           write the zip
//   node scripts/build-woo-plugin.mjs --check   exit 1 when the zip is out of date
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { zipSync } from 'fflate'

const root = new URL('..', import.meta.url).pathname
const source = join(root, 'integrations/woocommerce/fullfilio-connect')
const target = join(root, 'public/downloads/fullfilio-connect.zip')

function files(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

export function buildZip() {
  const mtime = new Date('2026-01-01T00:00:00Z')
  const entries = {}
  for (const path of files(source)) {
    entries[`fullfilio-connect/${relative(source, path)}`] = [new Uint8Array(readFileSync(path)), { mtime, level: 9 }]
  }
  return Buffer.from(zipSync(entries, { mtime }))
}

const zip = buildZip()
if (process.argv.includes('--check')) {
  const same = existsSync(target) && Buffer.compare(readFileSync(target), zip) === 0
  if (!same) {
    console.error('public/downloads/fullfilio-connect.zip is out of date — run: node scripts/build-woo-plugin.mjs')
    process.exit(1)
  }
  console.log('fullfilio-connect.zip is up to date')
} else {
  writeFileSync(target, zip)
  console.log(`wrote ${relative(root, target)} (${zip.length} bytes)`)
}
