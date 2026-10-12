import { afterEach, describe, expect, it, vi } from 'vitest'
import { filesApi, serveFile, sniff, type FilesEnv } from './files.ts'

const MERCHANT = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const PDF = new TextEncoder().encode('%PDF-1.7\n...')

/** An in-memory R2 bucket. */
function bucket() {
  const items = new Map<string, { body: Uint8Array; meta: { contentType?: string; cacheControl?: string } }>()
  return {
    items,
    async put(key: string, body: Uint8Array, opts: { httpMetadata?: { contentType?: string; cacheControl?: string } }) {
      items.set(key, { body, meta: opts.httpMetadata ?? {} })
    },
    async get(key: string) {
      const item = items.get(key)
      if (!item) return null
      return {
        body: new Blob([item.body]).stream(),
        httpEtag: '"etag"',
        writeHttpMetadata(h: Headers) {
          if (item.meta.contentType) h.set('Content-Type', item.meta.contentType)
          if (item.meta.cacheControl) h.set('Cache-Control', item.meta.cacheControl)
        },
      }
    },
    async delete(key: string) { items.delete(key) },
  }
}

/** The database's answer to file_access: allowed (the merchant id) or the error it raises. */
function database(answer: { merchant: string } | { error: string }) {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) })
    return 'merchant' in answer
      ? Response.json(answer.merchant)
      : Response.json({ message: answer.error, code: 'P0001' }, { status: 400 })
  }))
  return calls
}

function env(files = bucket()): FilesEnv & { files: ReturnType<typeof bucket> } {
  return { FILES: files as unknown as R2Bucket, files, SUPABASE_URL: 'https://db.example.supabase.co', SUPABASE_ANON_KEY: 'anon', FILES_SIGNING_KEY: 'test-signing-key-0123456789' }
}

const upload = (query: string, body: Uint8Array, type: string, auth = 'Bearer user-jwt') =>
  new Request(`https://app.example.com/functions/v1/files/upload?${query}`, {
    method: 'POST', body, headers: { Authorization: auth, 'Content-Type': type, 'x-merchant-id': MERCHANT },
  })

afterEach(() => vi.unstubAllGlobals())

describe('R2 files', () => {
  it('recognises file types by their first bytes', () => {
    expect(sniff(PNG)).toBe('image/png')
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniff(PDF)).toBe('application/pdf')
    expect(sniff(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull()
  })

  it('stores a product image in the store\'s own folder after the database allows it', async () => {
    const e = env()
    const calls = database({ merchant: MERCHANT })
    const res = await filesApi(e)(upload('bucket=product-images&folder=prod-1&name=shirt.png', PNG, 'image/png'))
    expect(res.status).toBe(201)
    const saved = await res.json()
    expect(saved.path).toMatch(new RegExp(`^${MERCHANT}/prod-1/[0-9a-f-]{36}\\.png$`))
    expect(saved.url).toBe(`https://app.example.com/files/product-images/${saved.path}`)
    expect([...e.files.items.keys()]).toEqual([`product-images/${saved.path}`])
    // Asked as the signed-in user, for their store, with the right action.
    expect(calls[0].url).toBe('https://db.example.supabase.co/rest/v1/rpc/file_access')
    expect(calls[0].headers.get('authorization')).toBe('Bearer user-jwt')
    expect(calls[0].headers.get('x-merchant-id')).toBe(MERCHANT)
    expect(calls[0].body).toEqual({ p_bucket: 'product-images', p_action: 'write' })
  })

  it('refuses without sign-in, without permission, and files that are not what they claim', async () => {
    const e = env()
    database({ merchant: MERCHANT })
    const anon = await filesApi(e)(new Request('https://app.example.com/functions/v1/files/upload?bucket=product-images&folder=p', { method: 'POST', body: PNG }))
    expect(anon.status).toBe(401)
    const html = await filesApi(e)(upload('bucket=product-images&folder=p&name=x.png', new TextEncoder().encode('<svg onload=alert(1)>'), 'image/png'))
    expect(html.status).toBe(422)
    const pdfAsImage = await filesApi(e)(upload('bucket=product-images&folder=p&name=x.pdf', PDF, 'application/pdf'))
    expect(pdfAsImage.status).toBe(422)
    const badFolder = await filesApi(e)(upload('bucket=product-images&folder=../x&name=x.png', PNG, 'image/png'))
    expect(badFolder.status).toBe(422)
    expect(e.files.items.size).toBe(0)

    database({ error: 'PERMISSION_DENIED: you do not have permission to do that' })
    const denied = await filesApi(e)(upload('bucket=product-images&folder=p&name=x.png', PNG, 'image/png'))
    expect(denied.status).toBe(403)
    expect(e.files.items.size).toBe(0)
  })

  it('private statements: a signed 5-minute link, no access without it, never another store\'s file', async () => {
    const e = env()
    database({ merchant: MERCHANT })
    const up = await (await filesApi(e)(upload('bucket=courier-invoices&folder=courier-1&name=March statement.pdf', PDF, 'application/pdf'))).json()
    expect(up.url).toBeNull()
    expect(up.path).toMatch(new RegExp(`^${MERCHANT}/courier-1/\\d+-March_statement\\.pdf$`))

    const plain = await serveFile(new Request(`https://app.example.com/files/courier-invoices/${up.path}`), e)
    expect(plain.status).toBe(404)

    const signReq = (path: string) => new Request('https://app.example.com/functions/v1/files/sign', {
      method: 'POST', body: JSON.stringify({ bucket: 'courier-invoices', path }), headers: { Authorization: 'Bearer user-jwt' },
    })
    const { url } = await (await filesApi(e)(signReq(up.path))).json()
    const file = await serveFile(new Request(url), e)
    expect(file.status).toBe(200)
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF)
    expect(file.headers.get('Content-Disposition')).toMatch(/^attachment/)
    expect(file.headers.get('Cache-Control')).toBe('private, no-store')

    const tampered = new URL(url)
    tampered.searchParams.set('expires', String(Number(tampered.searchParams.get('expires')) + 3600))
    expect((await serveFile(new Request(tampered), e)).status).toBe(404)

    const theirs = await filesApi(e)(signReq(`${OTHER}/courier-1/1-x.pdf`))
    expect(theirs.status).toBe(404)
  })

  it('serves public images with safe headers and deletes only the store\'s own files', async () => {
    const e = env()
    database({ merchant: MERCHANT })
    const up = await (await filesApi(e)(upload('bucket=product-images&folder=p1&name=a.png', PNG, 'image/png'))).json()
    const img = await serveFile(new Request(`https://app.example.com/files/product-images/${up.path}`), e)
    expect(img.status).toBe(200)
    expect(img.headers.get('Content-Type')).toBe('image/png')
    expect(img.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(img.headers.get('Content-Security-Policy')).toContain('sandbox')

    const del = (path: string) => filesApi(e)(new Request('https://app.example.com/functions/v1/files/delete', {
      method: 'POST', body: JSON.stringify({ bucket: 'product-images', path }), headers: { Authorization: 'Bearer user-jwt' },
    }))
    expect((await del(`${OTHER}/p1/x.png`)).status).toBe(404)
    expect(e.files.items.size).toBe(1)
    expect((await del(up.path)).status).toBe(200)
    expect(e.files.items.size).toBe(0)
  })

  it('uses the bucket\'s own domain for public links when one is set', async () => {
    const e = { ...env(), FILES_PUBLIC_URL: 'https://files.example.com/' }
    database({ merchant: MERCHANT })
    const up = await (await filesApi(e)(upload('bucket=product-images&folder=theme&name=hero.png', PNG, 'image/png'))).json()
    expect(up.url).toBe(`https://files.example.com/product-images/${up.path}`)
  })
})
