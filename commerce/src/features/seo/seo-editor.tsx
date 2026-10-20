import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ImageIcon, Lock, RotateCcw, Sparkles, Wand2, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Field } from '@/components/common/field'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { toUserMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { getSeoItem, saveSeoItem, SEO_MODES, type SeoItem, type SeoItemChanges, type SeoItemType, type SeoSource } from '@/services/seo'

// One item's SEO (a product, a collection or a store page): how it shows in search results and
// when shared, and the fields behind it. Under Hybrid a field the merchant writes is locked
// (generation never changes it) until "Reset to automatic" hands it back.

interface Values {
  title: string
  description: string
  slug: string
  canonical_url: string
  noindex: boolean
  focus_keyword: string
  og_image: string
  alts: Record<string, string>
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

function toValues(item: SeoItem): Values {
  return {
    title: item.stored_title ?? '',
    description: item.stored_description ?? '',
    slug: item.slug ?? '',
    canonical_url: item.custom_canonical ?? '',
    noindex: item.noindex,
    focus_keyword: item.focus_keyword ?? '',
    og_image: item.custom_og_image ?? '',
    alts: Object.fromEntries((item.images ?? []).map((i) => [i.id, i.alt ?? ''])),
  }
}

/** What changed since the item was loaded, as seo_item_save takes it (null: back to automatic). */
function changesOf(item: SeoItem, v: Values): SeoItemChanges {
  const from = toValues(item)
  const c: SeoItemChanges = {}
  if (v.title.trim() !== from.title) c.title = v.title.trim() || null
  if (v.description.trim() !== from.description) c.description = v.description.trim() || null
  if (item.type !== 'page' && v.slug.trim() !== from.slug) c.slug = v.slug.trim()
  if (v.canonical_url.trim() !== from.canonical_url) c.canonical_url = v.canonical_url.trim() || null
  if (v.noindex !== from.noindex) c.noindex = v.noindex
  if (v.focus_keyword.trim() !== from.focus_keyword) c.focus_keyword = v.focus_keyword.trim() || null
  if (v.og_image.trim() !== from.og_image) c.og_image = v.og_image.trim() || null
  const alts = Object.entries(v.alts).filter(([id, alt]) => alt.trim() !== (from.alts[id] ?? '')).map(([id, alt]) => ({ id, alt: alt.trim() || null }))
  if (alts.length) c.image_alts = alts
  return c
}

/** Problems that stop a save (shown under the fields). */
function problemsOf(item: SeoItem, v: Values): Partial<Record<keyof Values, string>> {
  const p: Partial<Record<keyof Values, string>> = {}
  if (v.title.trim().length > 300) p.title = 'At most 300 characters'
  if (v.description.trim().length > 1000) p.description = 'At most 1000 characters'
  if (item.type !== 'page' && (!SLUG.test(v.slug.trim()) || v.slug.trim().length > 80)) p.slug = 'Lower-case letters, digits and single dashes (up to 80)'
  if (v.canonical_url.trim() && !/^https:\/\/\S+$/.test(v.canonical_url.trim())) p.canonical_url = 'A full address starting with https://'
  if (v.og_image.trim() && !/^(https?:\/\/|\/)\S+$/.test(v.og_image.trim())) p.og_image = 'A web address of an image'
  if (v.focus_keyword.trim().length > 100) p.focus_keyword = 'At most 100 characters'
  return p
}

/** The editor's state for one item; save() writes only what changed. */
export function useSeoEditor(type: SeoItemType, key: string | undefined) {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['seo-item', type, key], enabled: !!key, queryFn: () => getSeoItem(type, key!) })
  const [values, setValues] = useState<Values | null>(null)
  // Fresh values whenever the item is (re)loaded from the server.
  useEffect(() => { if (query.data) setValues(toValues(query.data)) }, [query.data])
  const item = query.data
  const changes = useMemo(() => (item && values ? changesOf(item, values) : {}), [item, values])
  const problems = useMemo(() => (item && values ? problemsOf(item, values) : {}), [item, values])
  const dirty = Object.keys(changes).length > 0
  const valid = Object.keys(problems).length === 0
  const save = useMutation({
    mutationFn: async () => {
      if (!item || !dirty) return item
      if (!valid) throw new Error('VALIDATION: fix the highlighted SEO fields first')
      return saveSeoItem(item.type, item.key, changes)
    },
    onSuccess: (saved) => {
      if (!saved) return
      queryClient.setQueryData(['seo-item', type, key], saved)
      void queryClient.invalidateQueries({ queryKey: ['seo-audit'] })
      void queryClient.invalidateQueries({ queryKey: ['storefront-seo'] })
      if (type === 'product') void queryClient.invalidateQueries({ queryKey: ['products'] })
      if (type === 'collection') void queryClient.invalidateQueries({ queryKey: ['categories'] })
    },
  })
  const set = <K extends keyof Values>(k: K, v: Values[K]) => setValues((cur) => (cur ? { ...cur, [k]: v } : cur))
  const reset = () => { if (item) setValues(toValues(item)) }
  return { query, item, values, set, changes, problems, dirty, valid, save, reset }
}
export type SeoEditorState = ReturnType<typeof useSeoEditor>

const SOURCE: Record<SeoSource, { label: string; tone: 'neutral' | 'info' | 'violet' | 'warning'; hint: string }> = {
  auto: { label: 'Automatic', tone: 'info', hint: 'Generated from your template each time the page is shown' },
  generated: { label: 'Generated', tone: 'violet', hint: 'Stored from the template (bulk generate); reset to follow the template again' },
  manual: { label: 'Written by you', tone: 'neutral', hint: 'Locked: generation and imports never change it' },
  missing: { label: 'Missing', tone: 'warning', hint: 'Nothing written and nothing to generate from' },
}

function SourceBadge({ source }: { source: SeoSource }) {
  const s = SOURCE[source]
  return <Badge variant={s.tone} title={s.hint}>{source === 'manual' && <Lock />}{s.label}</Badge>
}

/** Character guidance: green inside the range search results show, amber outside it. */
function Count({ n, min, max }: { n: number; min: number; max: number }) {
  const ok = n >= min && n <= max
  return <span className={cn('tabular-nums', n === 0 ? 'text-muted-foreground' : ok ? 'text-emerald-600' : 'text-amber-600')}>{n} / {max}</span>
}

const hostOf = (base: string | null) => {
  try { return base ? new URL(base).host : location.host } catch { return location.host }
}

/** How the page shows in Google's results (an approximation: Google may rewrite either line). */
export function SerpPreview({ base, path, title, description }: { base: string | null; path: string; title: string; description: string | null }) {
  const host = hostOf(base)
  const crumbs = path.split('/').filter(Boolean)
  return (
    <div className="rounded-lg border bg-white p-4 text-left text-[#202124] dark:bg-white" aria-label="Search result preview">
      <div className="flex items-center gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[#dadce0] bg-[#f1f3f4] text-[11px] font-semibold uppercase text-[#5f6368]">{host.slice(0, 1)}</span>
        <div className="min-w-0 leading-tight">
          <p className="truncate text-[13px]">{host}</p>
          <p className="truncate text-[12px] text-[#4d5156]">https://{host}{crumbs.length ? ` › ${crumbs.join(' › ')}` : ''}</p>
        </div>
      </div>
      <p className="mt-1.5 line-clamp-1 text-[19px] leading-snug text-[#1a0dab]">{title || 'Untitled'}</p>
      <p className={cn('mt-0.5 line-clamp-2 text-[13px] leading-[1.58] text-[#4d5156]', !description && 'italic')}>
        {description || 'No meta description: search engines will pick text from the page.'}
      </p>
    </div>
  )
}

/** How a link to the page looks when shared (Facebook, WhatsApp, X). */
export function SocialPreview({ base, title, description, image }: { base: string | null; title: string; description: string | null; image: string | null }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card text-left" aria-label="Sharing preview">
      <div className="flex aspect-[1.91/1] max-w-full items-center justify-center bg-muted">
        {image ? <img src={image} alt="" className="size-full object-cover" /> : <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><ImageIcon className="size-4" /> No sharing image</span>}
      </div>
      <div className="space-y-0.5 border-t px-3 py-2.5">
        <p className="truncate text-[11px] tracking-wide text-muted-foreground uppercase">{hostOf(base)}</p>
        <p className="line-clamp-1 text-sm font-semibold">{title}</p>
        {description && <p className="line-clamp-1 text-xs text-muted-foreground">{description}</p>}
      </div>
    </div>
  )
}

function Check1({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-center gap-1.5">
      {ok ? <Check className="size-3.5 text-emerald-600" /> : <X className="size-3.5 text-muted-foreground" />}
      <span className={ok ? '' : 'text-muted-foreground'}>{children}</span>
    </li>
  )
}

/** The panel's fields and previews (the caller decides where Save lives). */
export function SeoFields({ editor, aiAvailable = false }: { editor: SeoEditorState; aiAvailable?: boolean }) {
  const { can } = useAuth()
  const { item, values, set, problems } = editor
  const [aiError, setAiError] = useState<string | null>(null)
  if (editor.query.isLoading || (item && !values)) return <LoadingState label="Loading SEO…" className="py-8" />
  if (editor.query.error || !item || !values) return <ErrorState error={editor.query.error ?? new Error('NOT_FOUND: that item does not exist')} onRetry={() => void editor.query.refetch()} className="py-8" />
  const canEdit = item.type === 'page' ? can('settings.manage') : can('products.manage')
  const mode = item.mode
  // What the store will show with the current (unsaved) values, under the store's mode.
  const shownTitle = mode === 'automatic' ? item.auto_title ?? item.name : values.title.trim() || (mode === 'manual' ? item.title : item.auto_title ?? item.name)
  const shownDesc = mode === 'automatic' ? item.auto_description : values.description.trim() || (mode === 'manual' ? null : item.auto_description)
  const titleSource: SeoSource = mode === 'automatic' ? 'auto' : values.title.trim()
    ? (values.title.trim() === item.stored_title ? item.title_source : 'manual') : mode === 'manual' ? 'missing' : 'auto'
  const descSource: SeoSource = mode === 'automatic' ? (item.auto_description ? 'auto' : 'missing') : values.description.trim()
    ? (values.description.trim() === item.stored_description ? item.description_source : 'manual') : mode === 'manual' || !item.auto_description ? 'missing' : 'auto'
  const slug = item.type === 'page' ? null : values.slug.trim()
  const path = item.type === 'product' ? `/product/${slug}` : item.type === 'collection' ? `/collection/${slug}` : item.path
  const kw = values.focus_keyword.trim().toLowerCase()
  const image = values.og_image.trim() || item.og_image
  const askAi = () => setAiError(aiAvailable
    ? 'AI writing is switched off for this store (SEO settings → AI suggestions).'
    : 'AI writing is not available: no AI provider is connected to Fullfilio yet. Use “Fill from template”, or write it yourself.')

  return (
    <fieldset disabled={!canEdit} className="min-w-0 space-y-5">
      {mode === 'automatic' && (
        <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
          <b className="text-foreground">Automatic mode:</b> titles and descriptions come from your templates. What you write here is saved but not shown until the store uses Hybrid or Manual (SEO settings).
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Search result</p>
          <SerpPreview base={item.base_url} path={path} title={shownTitle} description={shownDesc} />
        </div>
        <div className="min-w-0 space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">When shared</p>
          <SocialPreview base={item.base_url} title={shownTitle} description={shownDesc} image={image} />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor={`seo-title-${item.key}`} className="flex items-center gap-2 text-sm font-medium">SEO title <SourceBadge source={titleSource} /></label>
          <span className="text-xs"><Count n={shownTitle.length} min={30} max={60} /></span>
        </div>
        <Input id={`seo-title-${item.key}`} value={values.title} onChange={(e) => set('title', e.target.value)} placeholder={item.auto_title ?? item.name} aria-invalid={!!problems.title} />
        <FieldActions
          hint={problems.title ?? (values.title ? 'Kept as written.' : `Empty: ${mode === 'manual' ? 'the page uses its name' : 'generated from your template'}.`)}
          error={!!problems.title}
          onFill={item.auto_title ? () => set('title', item.auto_title ?? '') : undefined}
          onReset={values.title ? () => set('title', '') : undefined}
          onAi={askAi}
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor={`seo-desc-${item.key}`} className="flex items-center gap-2 text-sm font-medium">Meta description <SourceBadge source={descSource} /></label>
          <span className="text-xs"><Count n={(shownDesc ?? '').length} min={120} max={160} /></span>
        </div>
        <Textarea id={`seo-desc-${item.key}`} rows={3} value={values.description} onChange={(e) => set('description', e.target.value)} placeholder={item.auto_description ?? 'Describe the page in a sentence or two'} aria-invalid={!!problems.description} />
        <FieldActions
          hint={problems.description ?? (values.description ? 'Kept as written.' : item.auto_description ? 'Empty: generated from your template.' : 'Empty, and nothing to generate it from (add a description to the item, or write one).')}
          error={!!problems.description}
          onFill={item.auto_description ? () => set('description', item.auto_description ?? '') : undefined}
          onReset={values.description ? () => set('description', '') : undefined}
          onAi={askAi}
        />
      </div>
      {aiError && <p role="alert" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900"><Sparkles className="mt-0.5 size-3.5 shrink-0" />{aiError}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        {item.type !== 'page' && (
          <Field label="Address (URL handle)" error={problems.slug} hint={`${path}${slug !== item.slug ? ' · the old address will redirect here' : ''}`}>
            <Input value={values.slug} onChange={(e) => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))} />
          </Field>
        )}
        <Field label="Focus keyword" error={problems.focus_keyword} hint="The search you most want this page to appear for (a guide for you; search engines do not read it)">
          <Input value={values.focus_keyword} onChange={(e) => set('focus_keyword', e.target.value)} placeholder="e.g. linen shirt" />
        </Field>
      </div>
      {kw && (
        <ul className="grid gap-1 text-xs sm:grid-cols-3">
          <Check1 ok={shownTitle.toLowerCase().includes(kw)}>In the title</Check1>
          <Check1 ok={(shownDesc ?? '').toLowerCase().includes(kw)}>In the description</Check1>
          <Check1 ok={path.toLowerCase().includes(kw.replace(/\s+/g, '-'))}>In the address</Check1>
        </ul>
      )}

      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
        <span>
          <span className="block text-sm font-medium">Hide from search engines</span>
          <span className="block text-xs text-muted-foreground">
            Adds noindex to this page and leaves it out of the sitemap. Now: <code>{item.robots}</code>{!item.active && ' (not published, so never indexed)'}
          </span>
        </span>
        <Switch checked={values.noindex} onCheckedChange={(v) => set('noindex', v)} />
      </label>

      <details className="group rounded-lg border px-3 py-2.5 text-sm">
        <summary className="cursor-pointer font-medium">Advanced: canonical address and sharing image</summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Canonical address" error={problems.canonical_url} hint="Only when this page copies another; empty uses this page's own address">
            <Input value={values.canonical_url} onChange={(e) => set('canonical_url', e.target.value)} placeholder={item.base_url ? `${item.base_url}${path}` : 'https://…'} />
          </Field>
          <Field label="Sharing image" error={problems.og_image} hint={item.image ? 'Empty uses the main image' : 'Empty uses the store’s default sharing image'}>
            <Input value={values.og_image} onChange={(e) => set('og_image', e.target.value)} placeholder="https://…" />
          </Field>
        </div>
      </details>

      {(item.images?.length ?? 0) > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Image alt text <span className="font-normal text-muted-foreground">— read aloud to blind shoppers and used by image search</span></p>
          <ul className="space-y-2">
            {item.images!.map((img) => (
              <li key={img.id} className="flex items-center gap-3">
                <img src={img.url} alt="" className="size-12 shrink-0 rounded-md border object-cover" />
                <Input className="min-w-0 flex-1" value={values.alts[img.id] ?? ''} placeholder={img.suggested_alt ?? 'Describe the image'}
                  onChange={(e) => set('alts', { ...values.alts, [img.id]: e.target.value })} aria-label="Alt text" />
                {img.suggested_alt && !(values.alts[img.id] ?? '').trim() && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => set('alts', { ...values.alts, [img.id]: img.suggested_alt ?? '' })}>Use suggestion</Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  )
}

function FieldActions({ hint, error, onFill, onReset, onAi }: { hint: string; error: boolean; onFill?: () => void; onReset?: () => void; onAi: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')} role={error ? 'alert' : undefined}>{hint}</p>
      <div className="flex flex-wrap gap-1">
        {onFill && <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={onFill}><Wand2 /> Fill from template</Button>}
        <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={onAi}><Sparkles /> Generate with AI</Button>
        {onReset && <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={onReset}><RotateCcw /> Reset to automatic</Button>}
      </div>
    </div>
  )
}

/** A self-contained SEO editor with its own Save (collections, store pages, the audit). */
export function SeoEditorDialog({ type, itemKey, name, open, onOpenChange, aiAvailable }: {
  type: SeoItemType; itemKey: string | null; name?: string; open: boolean; onOpenChange: (open: boolean) => void; aiAvailable?: boolean
}) {
  const editor = useSeoEditor(type, itemKey ?? undefined)
  const [confirmClose, setConfirmClose] = useState(false)
  const close = (o: boolean) => {
    if (!o && editor.dirty) { setConfirmClose(true); return }
    onOpenChange(o)
  }
  const save = () => editor.save.mutate(undefined, { onSuccess: () => { toast.success('SEO saved'); onOpenChange(false) } })
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>SEO · {editor.item?.name ?? name ?? '…'}</DialogTitle>
          <DialogDescription>{editor.item ? `${SEO_MODES[editor.item.mode].label} mode — ${SEO_MODES[editor.item.mode].summary}` : 'How this page shows in search results and when shared.'}</DialogDescription>
        </DialogHeader>
        <SeoFields editor={editor} aiAvailable={aiAvailable} />
        {editor.save.error && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{toUserMessage(editor.save.error)}</p>}
        {confirmClose ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
            <span className="mr-auto text-sm">Close without saving your SEO changes?</span>
            <Button variant="outline" onClick={() => setConfirmClose(false)}>Keep editing</Button>
            <Button variant="destructive" onClick={() => { setConfirmClose(false); editor.reset(); onOpenChange(false) }}>Discard changes</Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
            {editor.dirty && <span className="mr-auto text-xs text-muted-foreground">Unsaved changes</span>}
            <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
            <Button onClick={save} disabled={!editor.dirty || !editor.valid || editor.save.isPending}>{editor.save.isPending && <Spinner />} Save SEO</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
