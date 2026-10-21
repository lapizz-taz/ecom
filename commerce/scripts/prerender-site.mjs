// After `vite build`: the Fullfilio website's pages as HTML, in dist/_site/ (one file per page).
//
//   vite build --ssr src/site-prerender.tsx && node scripts/prerender-site.mjs
//
// The Worker puts each page's HTML inside <div id="root"> on fullfilio.com, so search engines
// and AI crawlers that do not run JavaScript still read the headings and text. A page that
// cannot be rendered is left out with a warning (the Worker then sends the plain app page, as
// before) and never stops the build.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist')

let site
try {
  site = await import(pathToFileURL(join(root, 'dist-ssr', 'site-prerender.js')).href)
} catch (error) {
  console.warn(`prerender-site: no server build (${error.message}); website pages are sent without HTML.`)
  process.exit(0)
}

rmSync(join(out, '_site'), { recursive: true, force: true })
let made = 0
for (const path of site.paths()) {
  try {
    const html = site.render(path)
    if (!html.includes('<h1')) throw new Error('no <h1> in the page')
    const file = join(out, site.siteFile(path))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${site.siteFileMark(path)}\n${html}`)
    made += 1
  } catch (error) {
    console.warn(`prerender-site: ${path} left out: ${error.message}`)
  }
}
console.log(`prerender-site: ${made} website pages written to dist/_site/`)
