// Meta's login opens in a small window over Fullfilio (like other inbox tools), not
// in place of the page. When Meta sends that window back to /admin/inbox/meta-callback,
// it hands the code to the Channels page that opened it and closes. Meta's pages cut
// window.opener, so the hand-off goes over a same-site BroadcastChannel; when no page
// answers (it was closed), the window simply finishes the connection itself.

const CHANNEL = 'fullfilio-meta-oauth'
const NAME = 'fullfilio-meta'

/** Opens the (blank) window straight from the click, so the browser does not block it. */
export function openMetaWindow(): Window | null {
  const w = 620
  const h = 760
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2))
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2))
  try {
    const win = window.open('about:blank', NAME, `popup,width=${w},height=${h},left=${left},top=${top}`)
    if (win) win.document.title = 'Opening Facebook…'
    return win
  } catch {
    return null
  }
}

/** Whether the sign-in was started in the popup (Fullfilio marks that in the signed state). */
export function startedInPopup(state: string): boolean {
  try {
    const payload = state.split('.')[0]
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((payload.length + 3) % 4))
    return (JSON.parse(json) as { w?: number }).w === 1
  } catch {
    return false
  }
}

/** In the popup: give Meta's answer to the Channels page. True when that page took it. */
export function handBack(search: string, waitMs = 1500): Promise<boolean> {
  if (typeof BroadcastChannel === 'undefined') return Promise.resolve(false)
  return new Promise((resolve) => {
    const bc = new BroadcastChannel(CHANNEL)
    const id = Math.random().toString(36).slice(2)
    const timer = setTimeout(() => { bc.close(); resolve(false) }, waitMs)
    bc.onmessage = (e: MessageEvent<{ type?: string; id?: string }>) => {
      if (e.data?.type !== 'ack' || e.data.id !== id) return
      clearTimeout(timer)
      bc.close()
      resolve(true)
    }
    bc.postMessage({ type: 'code', id, search })
  })
}

/** On the Channels page: run onCode with Meta's answer (the callback's query string). */
export function listenForMetaAnswer(onCode: (search: string) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined
  const bc = new BroadcastChannel(CHANNEL)
  bc.onmessage = (e: MessageEvent<{ type?: string; id?: string; search?: string }>) => {
    if (e.data?.type !== 'code' || typeof e.data.search !== 'string') return
    bc.postMessage({ type: 'ack', id: e.data.id })
    onCode(e.data.search)
  }
  return () => bc.close()
}
