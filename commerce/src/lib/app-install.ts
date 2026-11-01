// Fullfilio as an app on the phone: the installed app opens the dashboard, and Android's own
// "Install app" prompt is kept for the install guide (features/shell/install-app.tsx).

/** The page runs as the installed app (home-screen icon), not in a browser tab. */
export function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: fullscreen)').matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true
  } catch {
    return false
  }
}

export type Platform = 'ios' | 'android' | 'other'

/** iPhone and iPad (iPadOS says "Macintosh" but has a touch screen), Android, or anything else. */
export function phonePlatform(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints ?? 0): Platform {
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return 'other'
}

function setMeta(name: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.name = name
    document.head.appendChild(el)
  }
  el.content = content
}

/**
 * On fullfilio.com the app is the dashboard: its manifest starts at /admin, so an app installed
 * from any page opens the admin. An app installed before (it starts at the website's home page)
 * goes on to the dashboard too. Returns true when the page is leaving for /admin.
 */
export function openPlatformAsApp(): boolean {
  if (isStandalone() && location.pathname === '/') {
    location.replace(`/admin${location.search}`)
    return true
  }
  const link = document.head.querySelector<HTMLLinkElement>('link[rel="manifest"]')
  if (link) link.href = '/admin.webmanifest'
  setMeta('mobile-web-app-capable', 'yes')
  setMeta('apple-mobile-web-app-capable', 'yes')
  setMeta('apple-mobile-web-app-title', 'Fullfilio')
  setMeta('apple-mobile-web-app-status-bar-style', 'black-translucent')
  return false
}

// ---------------------------------------------------------------- Android's install prompt

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()
const notify = () => { for (const l of listeners) l() }

/** Keeps Chrome's install prompt (it fires once, early) so a button can show it later. */
export function captureInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as InstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    notify()
  })
}

/** Chrome or Edge on Android (or a computer) can install the app with one tap. */
export function canPromptInstall(): boolean {
  return deferred !== null
}

export function onInstallPromptChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Shows the browser's own install dialog. True when the person installed the app. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred
  if (!event) return false
  deferred = null
  notify()
  await event.prompt()
  return (await event.userChoice).outcome === 'accepted'
}
