// Uploads on Cloudflare R2 through the site's Worker (Cloudflare builds:
// VITE_FILE_STORE=r2). The Worker asks the database whether the signed-in
// staff member may do this, and keeps every file in their store's own folder.
// Stored paths carry an "r2:" prefix so older Supabase Storage paths still
// work (they are signed and removed through Supabase).
import { AppError } from '@/lib/errors'
import { functionsUrl } from '@/lib/env'
import { functionHeaders, functionResult } from '@/lib/functions'
import { merchantFetch } from '@/lib/merchant'

export type FileBucket = 'product-images' | 'courier-invoices'

export const R2_PREFIX = 'r2:'
export const isR2Path = (path: string) => path.startsWith(R2_PREFIX)

async function send<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await merchantFetch(functionsUrl(`files/${path}`), { ...init, method: 'POST', headers: { ...(await functionHeaders()), ...(init.headers ?? {}) } })
  } catch {
    throw new AppError('Network problem — please try again', 'NETWORK')
  }
  return functionResult<T>(res)
}

/** Stores a file in the store's folder (`folder` is a product id, a courier id or "theme"). */
export async function uploadFile(bucket: FileBucket, folder: string, file: File): Promise<{ path: string; url: string | null }> {
  const query = new URLSearchParams({ bucket, folder, name: file.name })
  const saved = await send<{ path: string; url: string | null }>(`upload?${query}`, {
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  })
  return { path: `${R2_PREFIX}${saved.path}`, url: saved.url }
}

/** A link to a private file that works for five minutes. */
export async function signedFileUrl(bucket: FileBucket, storedPath: string): Promise<string> {
  const { url } = await send<{ url: string }>('sign', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucket, path: storedPath.slice(R2_PREFIX.length) }),
  })
  return url
}

export async function deleteFile(bucket: FileBucket, storedPath: string): Promise<void> {
  await send('delete', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucket, path: storedPath.slice(R2_PREFIX.length) }),
  })
}
