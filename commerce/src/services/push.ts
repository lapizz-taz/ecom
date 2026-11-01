import { invokeFunction } from '@/lib/functions'
import { isStandalone, phonePlatform } from '@/lib/app-install'
import { fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'

// New-order notifications on this device (supabase/functions/push, public/push-sw.js).

const WORKER = '/push-sw.js'
const SCOPE = '/admin/'

export type PushState =
  /** This browser cannot do push at all. */
  | 'unsupported'
  /** iPhone/iPad: push works only in the app added to the Home Screen (iOS 16.4 or later). */
  | 'install-first'
  /** The person said no in the browser; only the browser's settings can undo it. */
  | 'blocked'
  | 'off'
  | 'on'

export interface PushDevices { devices: number; this_device: boolean }

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null
  return (await navigator.serviceWorker.getRegistration(SCOPE)) ?? null
}

/** This device's push subscription, if notifications are on in this browser. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  return (await (await registration())?.pushManager.getSubscription()) ?? null
}

/** Where notifications stand on this device (the browser's side and ours). */
export async function pushState(): Promise<PushState> {
  // iPhone and iPad: only the app on the Home Screen may get notifications, whatever Safari offers.
  if (phonePlatform() === 'ios' && !isStandalone()) return 'install-first'
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  const sub = await currentPushSubscription()
  if (!sub || Notification.permission !== 'granted') return 'off'
  const mine = await pushDevices(sub.endpoint)
  return mine.this_device ? 'on' : 'off'
}

export async function pushDevices(endpoint?: string | null): Promise<PushDevices> {
  const { data, error } = await supabase.rpc('push_my_devices', { p_endpoint: endpoint ?? undefined })
  if (error) throw error
  return fromJson<PushDevices>(data)
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false
  const x = new Uint8Array(a)
  return x.every((v, i) => v === b[i])
}

async function activeWorker(reg: ServiceWorkerRegistration): Promise<void> {
  if (reg.active) return
  const worker = reg.installing ?? reg.waiting
  if (!worker) return
  await new Promise<void>((done) => {
    const check = () => { if (worker.state === 'activated') { worker.removeEventListener('statechange', check); done() } }
    worker.addEventListener('statechange', check)
    check()
  })
}

/** "Android · Chrome", "iPhone · App": which device a person's list means. */
export function deviceLabel(ua = navigator.userAgent): string {
  const platform = phonePlatform(ua)
  const os = platform === 'ios' ? (/iPad|Macintosh/.test(ua) ? 'iPad' : 'iPhone') : platform === 'android' ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Computer'
  const browser = isStandalone() ? 'App' : /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox'
    : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  return `${os} · ${browser}`
}

/**
 * Turns new-order notifications on for this device. Must run from a tap (browsers ask for
 * permission only then). Returns the state afterwards ('blocked' when the person said no).
 */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return pushState()
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off'
  const reg = await navigator.serviceWorker.register(WORKER, { scope: SCOPE })
  await activeWorker(reg)
  const { public_key } = await invokeFunction<{ public_key: string }>('push', { action: 'key' })
  const appKey = keyBytes(public_key)
  let sub = await reg.pushManager.getSubscription()
  if (sub && !sameKey(sub.options.applicationServerKey, appKey)) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey })
  const json = sub.toJSON()
  const { error } = await supabase.rpc('push_subscribe', {
    p_endpoint: sub.endpoint, p_p256dh: json.keys?.p256dh ?? '', p_auth: json.keys?.auth ?? '', p_device: deviceLabel(),
  })
  if (error) throw error
  return 'on'
}

/** Turns them off for this device (here and with the push service). */
export async function disablePush(): Promise<void> {
  const sub = await currentPushSubscription()
  if (!sub) return
  const { error } = await supabase.rpc('push_unsubscribe', { p_endpoint: sub.endpoint })
  await sub.unsubscribe().catch(() => false)
  if (error) throw error
}

/** Signed out: this browser stops getting them (the server drops the device on the next push). */
export async function dropLocalPush(): Promise<void> {
  try { await (await currentPushSubscription())?.unsubscribe() } catch { /* nothing subscribed here */ }
}

/** A test notification to this device. */
export async function sendTestPush(): Promise<{ sent: number; gone: number; failed: number }> {
  const sub = await currentPushSubscription()
  return invokeFunction('push', { action: 'test', endpoint: sub?.endpoint })
}
