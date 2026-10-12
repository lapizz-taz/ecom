// Uploaded files on Cloudflare R2 (Supabase Storage's job before the move).
//
//   POST /functions/v1/files/upload?bucket=…&folder=…&name=…   body: the file
//   POST /functions/v1/files/sign     { bucket, path }  → a 5-minute link (private files)
//   POST /functions/v1/files/delete   { bucket, path }
//   GET  /files/<bucket>/<path>       public buckets; private ones only with a signed link
//
// The database decides every call as the signed-in staff member
// (public.file_access): the permissions of the old Storage policies, and only
// the store's own folder (<merchant id>/…). Nothing a browser sends picks the
// folder or the file name.
import { corsHeaders, fromDbError, handle, HttpError, json, readJson } from '../supabase/functions/_shared/http.ts'

export interface FilesEnv {
  FILES?: R2Bucket
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  SUPABASE_PUBLISHABLE_KEY?: string
  /** Secret for private-file links (any long random string); derived from the service key when unset. */
  FILES_SIGNING_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  /** Public address of the bucket's custom domain (e.g. https://files.example.com); else /files on this site. */
  FILES_PUBLIC_URL?: string
}

type Bucket = 'product-images' | 'courier-invoices' | 'order-files' | 'documents'

const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }
const DOCUMENT_TYPES: Record<string, string> = {
  ...IMAGE_TYPES,
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}

const BUCKETS: Record<Bucket, { public: boolean; maxBytes: number; types: Record<string, string> }> = {
  'product-images': { public: true, maxBytes: 8 * 1024 * 1024, types: IMAGE_TYPES },
  'courier-invoices': { public: false, maxBytes: 10 * 1024 * 1024, types: DOCUMENT_TYPES },
  'order-files': { public: false, maxBytes: 10 * 1024 * 1024, types: DOCUMENT_TYPES },
  documents: { public: false, maxBytes: 10 * 1024 * 1024, types: DOCUMENT_TYPES },
}

const SIGNED_LINK_SECONDS = 300
const PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/[A-Za-z0-9._-]{1,120}){1,3}$/
const FOLDER = /^[A-Za-z0-9_-]{1,64}$/

function bucketOf(value: unknown): Bucket {
  if (typeof value === 'string' && value in BUCKETS) return value as Bucket
  throw new HttpError(422, 'Unknown file store', 'VALIDATION')
}

function pathOf(value: unknown): string {
  if (typeof value === 'string' && PATH.test(value) && !value.includes('..')) return value
  throw new HttpError(422, 'Not a file address', 'VALIDATION')
}

function store(env: FilesEnv): R2Bucket {
  if (!env.FILES) throw new HttpError(503, 'File storage is not set up (R2 binding FILES)', 'NOT_CONFIGURED')
  return env.FILES
}

/** The caller's store, when the database allows this action on this kind of file. */
async function allowed(req: Request, env: FilesEnv, bucket: Bucket, action: 'read' | 'write' | 'delete'): Promise<string> {
  const auth = req.headers.get('Authorization') ?? ''
  if (!/^Bearer\s+\S+/i.test(auth)) throw new HttpError(401, 'Please sign in', 'UNAUTHENTICATED')
  const base = env.SUPABASE_URL?.replace(/\/+$/, '')
  const key = env.SUPABASE_ANON_KEY ?? env.SUPABASE_PUBLISHABLE_KEY
  if (!base || !key) throw new HttpError(503, 'The database address is not set', 'NOT_CONFIGURED')
  const headers: Record<string, string> = { apikey: key, Authorization: auth, 'Content-Type': 'application/json' }
  const merchant = req.headers.get('x-merchant-id')
  if (merchant) headers['x-merchant-id'] = merchant
  const res = await fetch(`${base}/rest/v1/rpc/file_access`, { method: 'POST', headers, body: JSON.stringify({ p_bucket: bucket, p_action: action }) })
  const body = await res.json().catch(() => null) as unknown
  if (!res.ok) {
    if (res.status === 401) throw new HttpError(401, 'Please sign in', 'UNAUTHENTICATED')
    throw fromDbError(body as { message?: string; code?: string })
  }
  if (typeof body !== 'string') throw new HttpError(500, 'Something went wrong. Please try again.', 'INTERNAL')
  return body
}

/** Checks the first bytes, so a file is what its type says (no HTML or scripts under an image name). */
export function sniff(bytes: Uint8Array): string | null {
  const at = (i: number, ...b: number[]) => b.every((v, k) => bytes[i + k] === v)
  const text = (i: number, s: string) => at(i, ...Array.from(s, (c) => c.charCodeAt(0)))
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (text(0, 'GIF87a') || text(0, 'GIF89a')) return 'image/gif'
  if (text(0, 'RIFF') && text(8, 'WEBP')) return 'image/webp'
  if (text(4, 'ftypavif') || text(4, 'ftypavis')) return 'image/avif'
  if (text(0, '%PDF-')) return 'application/pdf'
  if (at(0, 0x50, 0x4b, 0x03, 0x04)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (at(0, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return 'application/vnd.ms-excel'
  return null
}

function looksLikeCsv(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 2048)).toLowerCase()
  return !/[\u0000-\u0008\u000e-\u001f]/.test(head) && !/<\s*(script|html|svg|iframe|body)/.test(head)
}

/** The key that signs private-file links: FILES_SIGNING_KEY, else one derived from the (secret) service key. */
function signingKey(env: FilesEnv): string | null {
  if (env.FILES_SIGNING_KEY) return env.FILES_SIGNING_KEY
  return env.SUPABASE_SERVICE_ROLE_KEY ? `fullfilio-file-links:${env.SUPABASE_SERVICE_ROLE_KEY}` : null
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')

async function signature(secret: string, bucket: string, path: string, expires: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${bucket}/${path}:${expires}`)))
}

function sameText(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

function publicUrl(req: Request, env: FilesEnv, bucket: Bucket, path: string): string {
  const base = env.FILES_PUBLIC_URL?.replace(/\/+$/, '')
  return base ? `${base}/${bucket}/${path}` : `${new URL(req.url).origin}/files/${bucket}/${path}`
}

function safeName(name: string | null): string {
  const clean = (name ?? '').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return clean.slice(-60) || 'file'
}

async function upload(req: Request, env: FilesEnv): Promise<Response> {
  const url = new URL(req.url)
  const bucket = bucketOf(url.searchParams.get('bucket'))
  const folder = url.searchParams.get('folder') ?? ''
  if (!FOLDER.test(folder)) throw new HttpError(422, 'Not a folder name', 'VALIDATION')
  const rule = BUCKETS[bucket]
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > rule.maxBytes) throw new HttpError(413, `Files must be smaller than ${rule.maxBytes / 1024 / 1024} MB`, 'PAYLOAD_TOO_LARGE')
  const merchant = await allowed(req, env, bucket, 'write')

  const body = new Uint8Array(await req.arrayBuffer())
  if (!body.byteLength) throw new HttpError(422, 'The file is empty', 'VALIDATION')
  if (body.byteLength > rule.maxBytes) throw new HttpError(413, `Files must be smaller than ${rule.maxBytes / 1024 / 1024} MB`, 'PAYLOAD_TOO_LARGE')
  const declaredType = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const type = sniff(body) ?? (declaredType === 'text/csv' && rule.types['text/csv'] && looksLikeCsv(body) ? 'text/csv' : null)
  if (!type || !rule.types[type]) {
    throw new HttpError(422, bucket === 'product-images' ? 'Please choose a JPG, PNG, WebP, GIF or AVIF image' : 'Please choose a PDF, Excel, CSV or image file', 'VALIDATION')
  }
  const name = bucket === 'product-images' ? crypto.randomUUID() : `${Date.now()}-${safeName(url.searchParams.get('name'))}`
  const path = `${merchant}/${folder}/${name}.${rule.types[type]}`
  await store(env).put(`${bucket}/${path}`, body, {
    httpMetadata: { contentType: type, cacheControl: rule.public ? 'public, max-age=31536000, immutable' : 'private, no-store' },
    customMetadata: { merchant },
  })
  return json(req, { bucket, path, url: rule.public ? publicUrl(req, env, bucket, path) : null }, 201)
}

async function sign(req: Request, env: FilesEnv): Promise<Response> {
  const input = await readJson<{ bucket?: unknown; path?: unknown }>(req)
  const bucket = bucketOf(input.bucket)
  const path = pathOf(input.path)
  const merchant = await allowed(req, env, bucket, 'read')
  if (!path.startsWith(`${merchant}/`)) throw new HttpError(404, 'File not found', 'NOT_FOUND')
  if (BUCKETS[bucket].public) return json(req, { url: publicUrl(req, env, bucket, path) })
  const key = signingKey(env)
  if (!key) throw new HttpError(503, 'Private files are not set up (FILES_SIGNING_KEY)', 'NOT_CONFIGURED')
  const expires = Math.floor(Date.now() / 1000) + SIGNED_LINK_SECONDS
  const sig = await signature(key, bucket, path, expires)
  return json(req, { url: `${new URL(req.url).origin}/files/${bucket}/${path}?expires=${expires}&sig=${sig}` }, 200, { 'Cache-Control': 'no-store' })
}

async function remove(req: Request, env: FilesEnv): Promise<Response> {
  const input = await readJson<{ bucket?: unknown; path?: unknown }>(req)
  const bucket = bucketOf(input.bucket)
  const path = pathOf(input.path)
  const merchant = await allowed(req, env, bucket, 'delete')
  if (!path.startsWith(`${merchant}/`)) throw new HttpError(404, 'File not found', 'NOT_FOUND')
  await store(env).delete(`${bucket}/${path}`)
  return json(req, { ok: true })
}

/** /functions/v1/files/… (signed-in staff). */
export function filesApi(env: FilesEnv): (req: Request) => Promise<Response> {
  return handle(async (req) => {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
    const action = new URL(req.url).pathname.replace(/^\/functions\/v1\/files\/?/, '').replace(/\/+$/, '')
    if (action === 'upload') return upload(req, env)
    if (action === 'sign') return sign(req, env)
    if (action === 'delete') return remove(req, env)
    throw new HttpError(404, 'Not found', 'NOT_FOUND')
  })
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } })

/** GET /files/<bucket>/<path>: public images for anyone; private files only with a valid signed link. */
export async function serveFile(req: Request, env: FilesEnv): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: corsHeaders(req) })
  const url = new URL(req.url)
  const match = /^\/files\/([a-z-]+)\/(.+)$/.exec(url.pathname)
  if (!match || !(match[1] in BUCKETS) || !PATH.test(match[2]) || match[2].includes('..')) return notFound()
  const bucket = match[1] as Bucket
  const path = match[2]
  if (!BUCKETS[bucket].public) {
    const expires = Number(url.searchParams.get('expires'))
    const sig = url.searchParams.get('sig') ?? ''
    const key = signingKey(env)
    if (!key || !Number.isFinite(expires) || expires < Date.now() / 1000) return notFound()
    if (!sameText(sig, await signature(key, bucket, path, expires))) return notFound()
  }
  const object = await store(env).get(`${bucket}/${path}`)
  if (!object) return notFound()
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('ETag', object.httpEtag)
  headers.set('X-Content-Type-Options', 'nosniff')
  // Uploaded files are data, never pages: no scripts, no framing, downloads for documents.
  headers.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
  if (!headers.get('Content-Type')?.startsWith('image/')) {
    headers.set('Content-Disposition', `attachment; filename="${path.split('/').pop()}"`)
  }
  if (BUCKETS[bucket].public) headers.set('Access-Control-Allow-Origin', '*')
  else headers.set('Cache-Control', 'private, no-store')
  return new Response(req.method === 'HEAD' ? null : object.body, { headers })
}
