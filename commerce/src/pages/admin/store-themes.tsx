import { ExternalLink, MoreHorizontal, Paintbrush, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { BLOCK_TYPES, PRODUCT_BLOCKS, toggleBlock, type ProductBlock } from '@/features/storefront/product-blocks'
import { resolveTheme, type Storefront } from '@/features/storefront/theme'
import { BlockThumb } from '@/features/theme-editor/block-library'
import { useThemeDraft } from '@/features/theme-editor/use-theme-draft'
import { useStoreAddress } from '@/hooks/use-store-address'
import { useStoreConfig } from '@/hooks/use-store-config'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'

// Store → Theme, like Shopify's Online Store page: the current theme with "Edit theme", and the
// product page block library underneath, each block switched on or off here (saved as a draft,
// live once published; the editor has the same switches and every setting).

export default function StoreThemesPage() {
  const s = useThemeDraft()
  const store = useStoreAddress()
  const { data: config } = useStoreConfig()
  const [q, setQ] = useState('')
  const draft = s.draft as Storefront | undefined
  const theme = useMemo(() => resolveTheme(draft), [draft])
  const blocks = theme.product_page.blocks

  const setBlocks = (next: ProductBlock[]) => {
    if (!draft) return
    s.replace({ ...draft, theme: { ...theme, product_page: { ...theme.product_page, blocks: next } } as unknown as Record<string, unknown> })
  }
  const on = (type: (typeof BLOCK_TYPES)[number]) => blocks.some((b) => b.type === type && b.enabled)
  const shown = BLOCK_TYPES.filter((t) => `${PRODUCT_BLOCKS[t].label} ${PRODUCT_BLOCKS[t].description}`.toLowerCase().includes(q.trim().toLowerCase()))
  const count = BLOCK_TYPES.filter(on).length
  const host = store.url ? new URL(store.url).host : null

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Theme</h1>
        <div className="flex gap-2">
          {store.url && <Button variant="outline" size="sm" asChild><a href={store.url} target="_blank" rel="noreferrer">View store <ExternalLink /></a></Button>}
        </div>
      </div>

      {/* Current theme */}
      <section className="overflow-hidden rounded-2xl bg-zinc-950 text-white shadow-sm">
        <div className="relative aspect-[16/8] overflow-hidden sm:aspect-[16/7]">
          <ThemePreview />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 p-5">
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold">{host ?? config?.store.name ?? 'Your store'}</p>
              <p className="text-[13px] text-white/75">
                {config?.store.name ?? 'Store'} · {s.unpublished ? 'Draft not published' : 'Live'}
                {s.savedAt ? ` · Last saved: ${formatDateTime(s.savedAt)}` : s.publishedAt ? ` · Published: ${formatDateTime(s.publishedAt)}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" asChild className="bg-white text-zinc-900 hover:bg-white/90"><Link to="/admin/store/theme/editor"><Paintbrush /> Edit theme</Link></Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="More" className="grid size-8 place-items-center rounded-lg text-white hover:bg-white/15"><MoreHorizontal className="size-4" /></button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem asChild disabled={!store.url}><a href={store.url ?? undefined} target="_blank" rel="noreferrer">View store</a></DropdownMenuItem>
                  <DropdownMenuItem asChild><Link to="/admin/store/seo">SEO</Link></DropdownMenuItem>
                  <DropdownMenuItem asChild><Link to="/admin/store/website">Website & domains</Link></DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled={!s.hasDraft || !s.canEdit || s.discardDraft.isPending}
                    onClick={() => { if (window.confirm('Discard the saved draft? Your store keeps what is live now.')) s.discardDraft.mutate() }}>Discard draft</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </section>

      {/* Block library */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Product page blocks</h2>
            <p className="text-[13px] text-muted-foreground">{count} of {BLOCK_TYPES.length} on. Switch a block on here; change its text, colours and order in <Link to="/admin/store/theme/editor?page=product" className="underline underline-offset-2">Edit theme</Link>.</p>
          </div>
          <label className="flex h-9 w-full items-center gap-2 rounded-lg border bg-background px-3 text-sm sm:w-64">
            <Search className="size-4 text-muted-foreground" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search blocks" className="min-w-0 flex-1 bg-transparent outline-none" />
          </label>
        </div>
        {!draft ? <div className="grid place-items-center py-16"><Spinner /></div> : (
          <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-4">
            {shown.map((t) => {
              const active = on(t)
              const added = blocks.find((b) => b.type === t)
              return (
                <article key={t} className={cn('flex flex-col overflow-hidden rounded-xl border bg-card transition-shadow', active && 'ring-1 ring-foreground/70')}>
                  <div className="grid h-28 place-items-center bg-[#fafafa] text-[#18181b]"><BlockThumb type={t} /></div>
                  <div className="flex flex-1 flex-col gap-1 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-[13px] font-semibold">{PRODUCT_BLOCKS[t].label}</h3>
                      <Switch checked={active} disabled={!s.canEdit} aria-label={`${PRODUCT_BLOCKS[t].label} ${active ? 'on' : 'off'}`}
                        onCheckedChange={(v) => setBlocks(toggleBlock(blocks, t, v))} />
                    </div>
                    <p className="flex-1 text-xs leading-snug text-muted-foreground">{PRODUCT_BLOCKS[t].description}</p>
                    {added && <Link to={`/admin/store/theme/editor?page=product&block=${encodeURIComponent(added.id)}`} className="mt-1 self-start text-xs font-medium text-[#2c6ecb] hover:underline">Edit block</Link>}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      {/* Unsaved switches: save as a draft or publish. */}
      {(s.dirty || s.unpublished) && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] backdrop-blur">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
            <p className="text-sm">{s.dirty ? 'Unsaved changes to your theme.' : 'Your draft is not live yet.'}</p>
            <div className="flex gap-2">
              {s.dirty && <Button variant="ghost" size="sm" onClick={() => s.reset()}>Discard</Button>}
              {s.dirty && <Button variant="outline" size="sm" disabled={!s.canEdit || s.save.isPending} onClick={() => s.save.mutate()}>{s.save.isPending && <Spinner className="size-3.5" />} Save draft</Button>}
              <Button size="sm" disabled={!s.canEdit || s.publish.isPending || s.save.isPending}
                onClick={() => { if (window.confirm('Publish? Your store shows these changes straight away.')) s.publish.mutate() }}>
                {s.publish.isPending && <Spinner className="size-3.5" />} Publish
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** The live store's home page, scaled down (not clickable). */
function ThemePreview() {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className="absolute inset-0">
      {!loaded && <div className="grid size-full place-items-center"><Spinner className="text-white/60" /></div>}
      <iframe title="Your store" src="/?theme_preview=1" tabIndex={-1} aria-hidden onLoad={() => setLoaded(true)}
        className={cn('pointer-events-none absolute top-0 left-0 h-[250%] w-[250%] origin-top-left scale-[0.4] border-0 bg-white transition-opacity', loaded ? 'opacity-100' : 'opacity-0')} />
    </div>
  )
}
