// Fullfilio new-order notifications. This worker only shows pushes and opens the order when one is
// tapped: it caches nothing and never handles page requests. Registered for /admin/ by
// src/services/push.ts; the push function (supabase/functions/push) sends the messages.
/* eslint-env serviceworker */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Fullfilio'
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body : '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: typeof data.tag === 'string' ? data.tag : 'fullfilio',
    renotify: true,
    data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/admin' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data && event.notification.data.url ? event.notification.data.url : '/admin', self.location.origin)
  if (url.origin !== self.location.origin) return
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue
      await client.focus()
      if ('navigate' in client) {
        try { await client.navigate(url.href) } catch { /* not ours to steer: the tap still brought it forward */ }
      }
      return
    }
    await self.clients.openWindow(url.href)
  })())
})
