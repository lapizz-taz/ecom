/**
 * Prints already-rendered label pages from a hidden frame that holds nothing
 * else: no admin layout, sidebar, dark theme or toasts can move, shrink or
 * add pages. The page size comes from `pageCss`; every page but the last
 * ends with a page break, so no blank sheet comes out at the end.
 */
export async function printInFrame(pagesHtml: string, pageCss: string, title = 'Shipping labels'): Promise<void> {
  const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
    .map((el) => el.outerHTML)
    .join('\n')
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(frame)
  const doc = frame.contentDocument!
  doc.open()
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '')}</title><base href="${document.baseURI}">
${styles}
<style>
${pageCss}
html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; color: #000; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.label-page { overflow: hidden; break-inside: avoid; break-after: page; page-break-after: always; box-shadow: none !important; margin: 0 !important; }
.label-page:last-child { break-after: auto; page-break-after: auto; }
</style></head><body>${pagesHtml}</body></html>`)
  doc.close()

  // Logos and fonts must be in before the dialog snapshots the page.
  await Promise.all([
    doc.fonts?.ready,
    ...Array.from(doc.images).map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r }))),
  ].filter(Boolean))
  await new Promise((r) => setTimeout(r, 50))

  const win = frame.contentWindow!
  const cleanup = () => setTimeout(() => frame.remove(), 500)
  win.addEventListener('afterprint', cleanup, { once: true })
  setTimeout(cleanup, 120_000)
  win.focus()
  win.print()
}
