import { supabase } from '@/lib/supabase'

const KEY = 'admin-device-token'

/** A random token that identifies this browser to device approval. Only its hash is stored on the server. */
function deviceToken(): string | null {
  try {
    let token = localStorage.getItem(KEY)
    if (!token || token.length < 32) {
      token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')
      localStorage.setItem(KEY, token)
    }
    return token
  } catch {
    return null // storage blocked: the device can't be recognised, the server decides
  }
}

/** "Chrome on Windows" style label shown to admins approving the device. */
export function deviceLabel(ua = navigator.userAgent): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'unknown system'
  return `${browser} on ${os}`
}

/**
 * Records this browser for the signed-in staff member and links the current
 * sign-in to it. Customers and deactivated accounts are refused by the server,
 * which is expected here; anything else is reported.
 */
export async function registerDevice(): Promise<void> {
  const token = deviceToken()
  if (!token) return
  const { error } = await supabase.rpc('device_register' as never, { p_token: token, p_label: deviceLabel() } as never)
  if (error && !/PERMISSION_DENIED|staff only/i.test(error.message)) console.warn('Device registration failed:', error.message)
}
