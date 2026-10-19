// The browser tab title, remembered per address, so a refresh shows the right
// name at once instead of a placeholder ("Store · Fullfilio") until the store loads.

type Area = 'admin' | 'store'

function key(area: Area): string {
  // A store at <platform>/s/<slug> shares the host with the website: keep each slug apart.
  const slug = area === 'store' ? (location.pathname.match(/^\/s\/[^/]+/)?.[0] ?? '') : ''
  return `title:${area}:${location.host}${slug}`
}

const areaOf = (path: string): Area => (path.startsWith('/admin') ? 'admin' : 'store')

/** Sets the tab title and remembers it for the next visit to this address. */
export function setPageTitle(area: Area, title: string): void {
  document.title = title
  try { localStorage.setItem(key(area), title) } catch { /* private mode: just this visit */ }
}

/** At start-up: the title this address had last time (the admin falls back to "Fullfilio"). */
export function restorePageTitle(): void {
  const area = areaOf(location.pathname)
  let title: string | null = null
  try { title = localStorage.getItem(key(area)) } catch { /* private mode */ }
  if (title) document.title = title
  else if (area === 'admin') document.title = 'Fullfilio'
}
