// Fullfilio new-order notifications. This worker only shows pushes and opens the order when one is
// tapped: it caches nothing and never handles page requests. Registered for /admin/ by
// src/services/push.ts; the push function (supabase/functions/push) sends the messages.
/* eslint-env serviceworker */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// An open admin plays its own "ka-ching" for new orders (src/lib/order-sound.ts). Asked first, so
// the notification stays quiet when it did and the phone does not sound twice. A page the phone has
// paused cannot answer: then the notification sounds as usual.
async function appPlayedSound(orders) {
  const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
    .filter((client) => {
      const url = new URL(client.url)
      return url.origin === self.location.origin && url.pathname.startsWith('/admin')
    })
  if (!windows.length) return false
  const answers = windows.map((client) => new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve(false), 1500)
    channel.port1.onmessage = (event) => {
      clearTimeout(timer)
      resolve(Boolean(event.data && event.data.played))
    }
    try {
      client.postMessage({ type: 'fullfilio-new-orders', orders }, [channel.port2])
    } catch {
      clearTimeout(timer)
      resolve(false)
    }
  }))
  return new Promise((resolve) => {
    let left = answers.length
    for (const answer of answers) {
      answer.then((played) => {
        if (played) resolve(true)
        else if (--left === 0) resolve(false)
      })
    }
  })
}

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Fullfilio'
  const orders = Array.isArray(data.orders) ? data.orders.filter((id) => typeof id === 'string').slice(0, 50) : []
  event.waitUntil((async () => {
    const quiet = orders.length ? await appPlayedSound(orders).catch(() => false) : false
    await self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: typeof data.tag === 'string' ? data.tag : 'fullfilio',
      renotify: true,
      silent: quiet,
      data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/admin' },
    })
  })())
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
