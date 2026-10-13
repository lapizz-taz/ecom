// Packs integrations/woocommerce/fullfilio-connect into public/downloads/fullfilio-connect.zip
// (the file staff download from Sales channels → WooCommerce) and writes
// public/downloads/fullfilio-connect.json, the update manifest installed plugins read to show
// "a new version is available" in WordPress (FFC_Updater: version, package, SHA-256, changelog).
// Same input → same bytes:
// files are sorted and stamped with a fixed date, so the committed zip can be checked
// against the source (src/lib/woo-plugin-zip.test.ts).
//   node scripts/build-woo-plugin.mjs           write the zip
//   node scripts/build-woo-plugin.mjs --check   exit 1 when the zip is out of date
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { zipSync } from 'fflate'

const root = new URL('..', import.meta.url).pathname
const source = join(root, 'integrations/woocommerce/fullfilio-connect')
const target = join(root, 'public/downloads/fullfilio-connect.zip')
const manifestTarget = join(root, 'public/downloads/fullfilio-connect.json')
const SITE = 'https://fullfilio.com'

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

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Version, requirements and the last few changelog entries, from the plugin header and readme.txt. */
export function buildManifest(zip) {
  const main = readFileSync(join(source, 'fullfilio-connect.php'), 'utf8')
  const readme = readFileSync(join(source, 'readme.txt'), 'utf8')
  const header = (text, name) => (text.match(new RegExp(`^[ *]*${name}:\\s*(.+)$`, 'mi')) || [])[1]?.trim() ?? ''
  const version = header(main, 'Version')
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`plugin header has no x.y.z Version (${version})`)
  if (header(readme, 'Stable tag') !== version) throw new Error(`readme.txt Stable tag (${header(readme, 'Stable tag')}) is not ${version}`)
  const log = (readme.split('== Changelog ==')[1] || '').split(/^= (\d+\.\d+\.\d+) =$/m).slice(1)
  let changelog = ''
  for (let i = 0; i < Math.min(log.length, 8); i += 2) {
    const items = log[i + 1].split('\n').filter((l) => l.startsWith('* ')).map((l) => `<li>${esc(l.slice(2).trim())}</li>`)
    changelog += `<h4>${esc(log[i])}</h4><ul>${items.join('')}</ul>`
  }
  const description = (readme.split('== Description ==')[1] || '').split(/^== /m)[0].trim().split('\n')
    .map((l) => l.trim()).filter(Boolean).map((l) => (l.startsWith('* ') ? `<li>${esc(l.slice(2))}</li>` : `<p>${esc(l)}</p>`)).join('')
    .replace(/((?:<li>.*?<\/li>)+)/g, '<ul>$1</ul>')
  return {
    name: 'Fullfilio Connect for WooCommerce',
    slug: 'fullfilio-connect',
    version,
    package: `${SITE}/downloads/fullfilio-connect.zip?v=${version}`,
    sha256: createHash('sha256').update(zip).digest('hex'),
    requires: header(readme, 'Requires at least'),
    tested: header(readme, 'Tested up to'),
    requires_php: header(readme, 'Requires PHP'),
    homepage: SITE,
    description,
    changelog,
  }
}

const zip = buildZip()
const manifest = Buffer.from(JSON.stringify(buildManifest(zip), null, 2) + '\n')
if (process.argv.includes('--check')) {
  const same = existsSync(target) && Buffer.compare(readFileSync(target), zip) === 0
  const sameManifest = existsSync(manifestTarget) && Buffer.compare(readFileSync(manifestTarget), manifest) === 0
  if (!same || !sameManifest) {
    console.error('public/downloads/fullfilio-connect.zip / .json are out of date — run: node scripts/build-woo-plugin.mjs')
    process.exit(1)
  }
  console.log('fullfilio-connect.zip and its update manifest are up to date')
} else {
  writeFileSync(target, zip)
  writeFileSync(manifestTarget, manifest)
  console.log(`wrote ${relative(root, target)} (${zip.length} bytes) and ${relative(root, manifestTarget)}`)
}
