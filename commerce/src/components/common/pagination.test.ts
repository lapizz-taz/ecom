import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Pagination } from './pagination'

const html = (props: Parameters<typeof Pagination>[0]) => renderToStaticMarkup(createElement(Pagination, props))
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

describe('pagination', () => {
  it('shows the range, "Page x of y" and Previous / Next', () => {
    const out = html({ page: 2, pageSize: 20, total: 45, onPage: () => undefined })
    expect(text(out)).toContain('21–40 of 45')
    expect(text(out)).toContain('Page 2 of 3')
    expect(out).toContain('aria-label="Previous page"')
    expect(out).toContain('aria-label="Next page"')
    // Without a page-size handler there is no "Rows per page".
    expect(text(out)).not.toContain('Rows per page')
  })

  it('offers "Rows per page" when asked, showing the current size', () => {
    const out = html({ page: 1, pageSize: 200, total: 350, onPage: () => undefined, pageSizes: [20, 50, 100, 200], onPageSize: () => undefined })
    expect(text(out)).toContain('Rows per page')
    expect(text(out)).toContain('1–200 of 350')
    expect(text(out)).toContain('Page 1 of 2')
    expect(out).toContain('aria-label="Rows per page"')
  })

  it('an empty list is page 1 of 1 with both buttons off', () => {
    const out = html({ page: 1, pageSize: 20, total: 0, onPage: () => undefined })
    expect(text(out)).toContain('0–0 of 0')
    expect(text(out)).toContain('Page 1 of 1')
    expect(out.match(/disabled=""/g)?.length).toBe(2)
  })
})
