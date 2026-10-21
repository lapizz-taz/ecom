import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft, ChevronDown, Copy, Eye, EyeOff, GripVertical, Home, LayoutTemplate, Maximize2, Monitor, MoreHorizontal, MousePointerClick,
  Package, Paintbrush, PanelBottom, PanelTop, Plus, Redo2, ShoppingBag, ShoppingCart, Smartphone, Store, Trash2, Undo2, X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { Spinner } from '@/components/common/states'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import {
  ACCENTS, CART_IMAGE_SIZE, CART_TEXT_SCALE, DEFAULT_THEME, FONTS, onColor, HEADING_SIZE, HEADING_WEIGHTS, makeSection, TEXT_SIZE, useThemeFont, RADII, resolveTheme, SECTIONS, type MenuLink, type ProductAccordion, type SectionType, type StoreTheme, type Storefront, type ThemeSection,
} from '@/features/storefront/theme'
import { PRODUCT_BLOCKS, toggleBlock, type ProductBlock } from '@/features/storefront/product-blocks'
import { applyPreset, findPreset } from '@/features/storefront/theme-presets'
import { BLOCK_ICON, BlockPicker } from '@/features/theme-editor/block-library'
import { ColorInput, FieldRow, inputClass, ListField, RangeInput, SchemaField, SelectInput } from '@/features/theme-editor/fields'
import { SECTION_ICON, SectionPicker } from '@/features/theme-editor/section-picker'
import { FontPicker } from '@/features/theme-editor/font-picker'
import { useThemeDraft } from '@/features/theme-editor/use-theme-draft'
import { useStoreConfig } from '@/hooks/use-store-config'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { getCategories, listProducts } from '@/services/storefront'
import { useStoreAddress } from '@/hooks/use-store-address'

type Tab = 'sections' | 'settings'
type Page = 'home' | 'collection' | 'product' | 'cart'
const FIXED: Record<string, string> = {
  announcement: 'Announcement bar', header: 'Header', footer: 'Footer', 'collection-banner': 'Collection banner', 'collection-grid': 'Product grid',
  'product-info': 'Product information', 'product-related': 'Related products', 'cart-drawer': 'Cart drawer',
}
const PAGES: Array<{ value: Page; label: string; short?: string; icon: ReactNode }> = [
  { value: 'home', label: 'Home page', short: 'Home', icon: <Home className="size-3.5" /> },
  { value: 'collection', label: 'Collections', icon: <LayoutTemplate className="size-3.5" /> },
  { value: 'product', label: 'Products', icon: <Package className="size-3.5" /> },
  { value: 'cart', label: 'Cart', icon: <ShoppingCart className="size-3.5" /> },
]

/** The theme editor: sections and theme settings on the left, the live store in the middle, the selected item's settings on the right. */
export default function StoreThemePage() {
  const s = useThemeDraft()
  const navigate = useNavigate()
  const location = useLocation()
  const { data: config } = useStoreConfig()
  const frame = useRef<HTMLIFrameElement>(null)
  const [tab, setTab] = useState<Tab>('sections')
  // Opened from Store → Theme: ?page=product&block=<id> starts on that page with the block selected.
  const [params, setParams] = useSearchParams()
  const [page, setPage] = useState<Page>(() => (PAGES.some((p) => p.value === params.get('page')) ? params.get('page') as Page : 'home'))
  const [selected, setSelected] = useState<string | null>(() => (params.get('block') ? `block:${params.get('block')}` : params.get('section')))
  const [device, setDevice] = useState<'desktop' | 'mobile' | 'full'>('desktop')
  const [inspect, setInspect] = useState(true)
  // Phones show the panel or the preview, one at a time (lg and up: side by side).
  const [mobileView, setMobileView] = useState<'edit' | 'preview'>('edit')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const history = useRef<{ past: Storefront[]; future: Storefront[]; last: number }>({ past: [], future: [], last: 0 })
  const [, bump] = useState(0)
  const draft = s.draft as Storefront | undefined
  const theme = useMemo(() => resolveTheme(draft), [draft])

  const categories = useQuery({ queryKey: ['storefront-categories'], queryFn: getCategories, staleTime: 10 * 60_000 })
  const firstProduct = useQuery({ queryKey: ['products', 'editor-first'], queryFn: () => listProducts({ limit: 1, sort: 'newest' }), staleTime: 5 * 60_000 })
  const firstCategory = categories.data?.find((c) => c.product_count > 0)?.slug
  // The preview opens the staff's own store at this site's root (?theme_preview=1 resolves it through
  // storefront_resolve_preview): same origin, so the editor can talk to it, and it works while the
  // store is off or selling on Shopify / WooCommerce, when no store address is published.
  const store = useStoreAddress()
  const path = page === 'home' ? '/' : page === 'collection' ? (firstCategory ? `/collection/${firstCategory}` : '/shop')
    : page === 'product' ? (firstProduct.data?.items[0] ? `/product/${firstProduct.data.items[0].slug}` : '/shop') : '/cart'

  const post = useCallback((msg: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(msg, window.location.origin), [])

  // Every change goes to the preview; the selection follows.
  useEffect(() => { post({ type: 'theme-preview', storefront: draft, selected, inspect }) }, [draft, inspect, post, selected])
  useEffect(() => { post({ type: 'theme-select', id: selected, scroll: true }) }, [selected, post])
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      if (e.data?.type === 'theme-preview-ready') post({ type: 'theme-preview', storefront: draft, selected, inspect })
      if (e.data?.type === 'theme-section-click') { setSelected(e.data.id); setTab('sections'); setMobileView('edit') }
      if (e.data?.type === 'theme-preview-error') setPreviewError(typeof e.data.message === 'string' && e.data.message ? e.data.message : 'Unknown error')
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [draft, inspect, post, selected])

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!s.dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [s.dirty])

  const commit = useCallback((next: Storefront) => {
    if (!draft) return
    const h = history.current
    if (Date.now() - h.last > 600) { h.past.push(draft); if (h.past.length > 100) h.past.shift() }
    h.future = []
    h.last = Date.now()
    s.replace(next as Record<string, unknown>)
    bump((n) => n + 1)
  }, [draft, s])
  const undo = useCallback(() => {
    const h = history.current
    const prev = h.past.pop()
    if (!prev || !draft) return
    h.future.push(draft); h.last = 0
    s.replace(prev as Record<string, unknown>); bump((n) => n + 1)
  }, [draft, s])
  const redo = useCallback(() => {
    const h = history.current
    const next = h.future.pop()
    if (!next || !draft) return
    h.past.push(draft); h.last = 0
    s.replace(next as Record<string, unknown>); bump((n) => n + 1)
  }, [draft, s])

  // The address follows the page and selection, so a reload opens the editor where it was.
  useEffect(() => {
    setParams((p) => {
      const next = new URLSearchParams(p)
      if (page === 'home') next.delete('page'); else next.set('page', page)
      next.delete('block'); next.delete('section')
      if (selected?.startsWith('block:')) next.set('block', selected.slice(6))
      else if (selected) next.set('section', selected)
      return next.toString() === p.toString() ? p : next
    }, { replace: true })
  }, [page, selected, setParams])

  // Opened from a ready-made theme on Store → Theme (?preset=bloom): its look goes on the draft once, undoable.
  const presetParam = params.get('preset')
  const presetDone = useRef(false)
  useEffect(() => {
    if (!presetParam || !draft || presetDone.current) return
    presetDone.current = true
    const preset = findPreset(presetParam)
    setParams((p) => { p.delete('preset'); return p }, { replace: true })
    if (!preset || !s.canEdit) return
    commit({ ...draft, theme: applyPreset(theme, preset) as unknown as Record<string, unknown> })
    toast.success(`${preset.name} is on your draft. Undo to go back, Publish to make it live.`)
  }, [commit, draft, presetParam, s.canEdit, setParams, theme])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || (e.target as HTMLElement)?.closest('input, textarea')) return
      if (e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo() }
      if (e.key.toLowerCase() === 'y') { e.preventDefault(); redo() }
      if (e.key.toLowerCase() === 's') { e.preventDefault(); if (s.dirty && s.canEdit) s.save.mutate() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [redo, s, undo])

  if (!draft) return <div className="fixed inset-0 z-[60] grid place-items-center bg-[#f1f1f1]"><Spinner /></div>

  const setTheme = (patch: Partial<StoreTheme>) => commit({ ...draft, theme: { ...theme, ...patch } as unknown as Record<string, unknown> })
  // The home page and product pages each have their own list of sections.
  const sections = page === 'product' ? theme.product_sections : theme.sections
  const setSections = (next: ThemeSection[]) => setTheme(page === 'product' ? { product_sections: next } : { sections: next })
  const setSectionSettings = (id: string, key: string, v: unknown) =>
    setSections(sections.map((x) => (x.id === id ? { ...x, settings: { ...x.settings, [key]: v } } : x)))
  const addSection = (type: SectionType) => {
    const sec = makeSection(type)
    setSections([...sections, sec])
    setSelected(sec.id); setPickerOpen(false)
  }
  const removeSection = (id: string) => { setSections(sections.filter((x) => x.id !== id)); setSelected(null) }
  // Product page blocks (product-blocks.ts): selected as "block:<id>".
  const blocks = theme.product_page.blocks
  const setBlocks = (next: ProductBlock[]) => setTheme({ product_page: { ...theme.product_page, blocks: next } })
  const addBlock = (type: Exclude<ProductBlock['type'], 'buttons'>) => {
    const next = toggleBlock(blocks, type, true)
    setBlocks(next)
    const added = next.find((b) => b.type === type)
    if (added) setSelected(`block:${added.id}`)
  }
  const currentBlock = selected?.startsWith('block:') ? blocks.find((b) => `block:${b.id}` === selected) : undefined
  const duplicate = (id: string) => {
    const i = sections.findIndex((x) => x.id === id)
    const copy = { ...makeSection(sections[i].type), settings: structuredClone(sections[i].settings) }
    setSections([...sections.slice(0, i + 1), copy, ...sections.slice(i + 1)])
    setSelected(copy.id)
  }
  // Back to the page the editor was opened from; Store → Theme when opened directly.
  const exit = () => {
    if (s.dirty && !window.confirm('Leave without saving your changes?')) return
    if (location.key !== 'default') navigate(-1)
    else navigate('/admin/store/theme')
  }
  const h = history.current
  const current = sections.find((x) => x.id === selected)

  return (
    <div data-theme-editor className="fixed inset-0 z-[60] flex flex-col bg-[#f1f1f1] text-[13px] text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-0.5 border-b border-zinc-200 bg-white px-1.5 whitespace-nowrap sm:gap-1 sm:px-2 dark:border-black/10 dark:bg-zinc-900">
        <IconButton label="Exit" onClick={exit}><ArrowLeft /></IconButton>
        <div className="mx-1 hidden h-5 w-px bg-zinc-200 sm:block dark:bg-black/10" />
        <IconButton label="Sections" active={tab === 'sections'} onClick={() => { setTab('sections'); setMobileView('edit') }}><PanelTop /></IconButton>
        <IconButton label="Theme settings" active={tab === 'settings'} onClick={() => { setTab('settings'); setMobileView('edit') }}><Paintbrush /></IconButton>

        <div className="mx-auto flex min-w-0 flex-1 items-center justify-center gap-2 sm:flex-none">
          <span className="hidden items-center gap-1.5 font-medium sm:flex"><Store className="size-3.5 text-zinc-500" />{config?.store.name ?? 'Store'}</span>
          {store.state && (
            <span className={cn('hidden rounded-full px-2 py-0.5 text-[11px] font-medium sm:inline', store.state.online
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'
              : 'bg-zinc-100 text-zinc-600 dark:bg-black/[0.07] dark:text-zinc-300')}>
              {store.state.label}
            </span>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 font-medium hover:bg-zinc-100 dark:hover:bg-black/[0.06] [&>svg]:shrink-0">
              <span className="max-sm:hidden">{PAGES.find((p) => p.value === page)?.icon}</span><span className="truncate sm:hidden">{PAGES.find((p) => p.value === page)?.short ?? PAGES.find((p) => p.value === page)?.label}</span><span className="truncate max-sm:hidden">{PAGES.find((p) => p.value === page)?.label}</span><ChevronDown className="size-3.5 text-zinc-500" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="z-[70] w-48">
              {PAGES.map((p) => <DropdownMenuItem key={p.value} onClick={() => { setPage(p.value); setSelected(null) }}>{p.icon}{p.label}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <span className="hidden sm:contents">
          <IconButton label={inspect ? 'Inspector on: click the preview to select' : 'Inspector off'} active={inspect} onClick={() => setInspect(!inspect)}><MousePointerClick /></IconButton>
        </span>
        <div className="hidden items-center sm:flex">
          <IconButton label="Desktop" active={device === 'desktop'} onClick={() => setDevice('desktop')}><Monitor /></IconButton>
          <IconButton label="Mobile" active={device === 'mobile'} onClick={() => setDevice('mobile')}><Smartphone /></IconButton>
          <IconButton label="Full width" active={device === 'full'} onClick={() => setDevice('full')}><Maximize2 /></IconButton>
        </div>
        <div className="mx-1 hidden h-5 w-px bg-zinc-200 sm:block dark:bg-black/10" />
        <span className="hidden sm:contents">
          <IconButton label="Undo" disabled={!h.past.length} onClick={undo}><Undo2 /></IconButton>
          <IconButton label="Redo" disabled={!h.future.length} onClick={redo}><Redo2 /></IconButton>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" aria-label="More" className="grid size-8 place-items-center rounded-lg hover:bg-zinc-100 dark:hover:bg-black/[0.06] [&_svg]:size-4"><MoreHorizontal /></button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="z-[70] w-52">
            {/* On phones the bar has no room for these. */}
            <DropdownMenuItem className="sm:hidden" disabled={!h.past.length} onSelect={(e) => { e.preventDefault(); undo() }}><Undo2 /> Undo</DropdownMenuItem>
            <DropdownMenuItem className="sm:hidden" disabled={!h.future.length} onSelect={(e) => { e.preventDefault(); redo() }}><Redo2 /> Redo</DropdownMenuItem>
            <DropdownMenuItem className="sm:hidden" onClick={() => setInspect(!inspect)}><MousePointerClick /> {inspect ? 'Turn off tap to select' : 'Turn on tap to select'}</DropdownMenuItem>
            <DropdownMenuSeparator className="sm:hidden" />
            <DropdownMenuItem asChild disabled={!store.url}><a href={store.url ?? undefined} target="_blank" rel="noreferrer">View store</a></DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!s.dirty} onClick={() => { s.reset(); history.current = { past: [], future: [], last: 0 }; bump((n) => n + 1) }}>Discard unsaved changes</DropdownMenuItem>
            <DropdownMenuItem disabled={!s.hasDraft || !s.canEdit || s.discardDraft.isPending} onClick={() => {
              if (window.confirm('Discard the saved draft? The editor goes back to what your store shows now. This cannot be undone.')) {
                s.discardDraft.mutate(); history.current = { past: [], future: [], last: 0 }; bump((n) => n + 1)
              }
            }}>Discard saved draft</DropdownMenuItem>
            <DropdownMenuItem onClick={() => { if (window.confirm('Reset the theme to the default look? You can still discard before saving.')) commit({ ...draft, theme: structuredClone(DEFAULT_THEME) as unknown as Record<string, unknown> }) }}>Reset to default theme</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className={cn('ml-1 hidden items-center gap-1.5 text-[12px] md:flex', s.dirty ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-500')} role="status">
          <span className={cn('size-1.5 rounded-full', s.dirty ? 'bg-amber-500' : s.unpublished ? 'bg-[#2c6ecb]' : 'bg-emerald-500')} />
          {s.dirty ? 'Unsaved changes' : s.unpublished ? 'Draft saved · not live' : 'Live'}
        </span>
        <button type="button" onClick={() => s.save.mutate()} disabled={!s.dirty || !s.canEdit || s.save.isPending || s.publish.isPending}
          title="Save as a draft: your store does not change until you publish"
          className="ml-1 flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-[13px] font-medium transition-opacity disabled:opacity-50 sm:px-3 dark:border-zinc-700 dark:bg-zinc-900">
          {s.save.isPending && <Spinner className="size-3.5" />} <span className="sm:hidden">Save</span><span className="max-sm:hidden">Save draft</span>
        </button>
        <button type="button" onClick={() => { if (window.confirm('Publish these changes? Your store shows them straight away.')) s.publish.mutate() }}
          disabled={(!s.dirty && !s.unpublished) || !s.canEdit || s.publish.isPending || s.save.isPending}
          className="ml-1 flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 sm:px-3.5 text-[13px] font-medium text-white shadow-[inset_0_-1px_0_rgb(255_255_255/.15)] transition-opacity disabled:bg-zinc-200 disabled:text-zinc-500 dark:bg-white dark:text-zinc-900 dark:disabled:bg-zinc-800">
          {s.publish.isPending && <Spinner className="size-3.5" />} Publish
        </button>
      </header>

      {/* Phones: edit or preview */}
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 bg-white px-2 py-1.5 lg:hidden dark:border-black/10 dark:bg-zinc-900">
        <div role="tablist" aria-label="View" className="grid flex-1 grid-cols-2 rounded-lg bg-zinc-100 p-0.5 dark:bg-black/[0.07]">
          {(['edit', 'preview'] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={mobileView === v} onClick={() => setMobileView(v)}
              className={cn('h-8 rounded-md text-[13px] font-medium transition-colors', mobileView === v ? 'bg-white shadow-sm dark:bg-zinc-950' : 'text-zinc-500')}>
              {v === 'edit' ? 'Edit' : 'Preview'}
            </button>
          ))}
        </div>
        <span className={cn('flex items-center gap-1.5 px-1 text-[12px]', s.dirty ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-500')} role="status">
          <span className={cn('size-1.5 rounded-full', s.dirty ? 'bg-amber-500' : s.unpublished ? 'bg-[#2c6ecb]' : 'bg-emerald-500')} />
          {s.dirty ? 'Unsaved' : s.unpublished ? 'Draft' : 'Live'}
        </span>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Left panel */}
        <aside className={cn('min-h-0 flex-1 overflow-y-auto bg-white lg:w-[300px] lg:flex-none lg:shrink-0 lg:border-r dark:border-black/10 dark:bg-zinc-900', mobileView === 'preview' && 'max-lg:hidden')}>
          <fieldset disabled={!s.canEdit} className="contents">
            {tab === 'sections' && (
              <SectionTree page={page} theme={theme} sections={sections} selected={selected} onSelect={setSelected} onSections={setSections}
                pickerOpen={pickerOpen} setPickerOpen={setPickerOpen} onAdd={addSection} blocks={blocks} onBlocks={setBlocks} onAddBlock={addBlock} />
            )}
            {tab === 'settings' && <ThemeSettings theme={theme} setTheme={setTheme} />}
          </fieldset>
        </aside>

        {/* Preview */}
        <div className={cn('min-h-0 min-w-0 flex-1 overflow-auto p-2 lg:p-3', mobileView === 'edit' && 'max-lg:hidden')}>
          {previewError && (
            <div role="alert" className="mx-auto mb-2 max-w-[1400px] rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              The preview could not load your store: {previewError}
            </div>
          )}
          <div className={cn('mx-auto h-full overflow-hidden rounded-lg bg-white shadow-[0_0_0_1px_rgb(0_0_0/.08),0_4px_16px_rgb(0_0_0/.06)] transition-[width] duration-300',
            device === 'mobile' ? 'w-[390px]' : device === 'full' ? 'w-full' : 'w-full max-w-[1400px]')}>
            <iframe ref={frame} key={path} title="Store preview" src={`${path}${path.includes('?') ? '&' : '?'}theme_preview=1`} className="size-full min-h-[50vh]"
              onLoad={() => { setPreviewError(null); post({ type: 'theme-preview', storefront: draft, selected, inspect }) }} />
          </div>
        </div>

        {/* Right panel: the selected item's settings */}
        {selected && (
          <aside className={cn('absolute inset-0 z-10 flex flex-col bg-white sm:left-auto sm:w-[340px] sm:border-l sm:border-zinc-200 sm:shadow-xl lg:static lg:w-[300px] lg:shadow-none dark:border-black/10 dark:bg-zinc-900', mobileView === 'preview' && 'max-lg:hidden')}>
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-black/10">
              <span className="text-zinc-500">{current ? SECTION_ICON[current.type] : currentBlock ? BLOCK_ICON[currentBlock.type] : <PanelBottom className="size-4" />}</span>
              <p className="min-w-0 flex-1 truncate font-semibold">
                {current ? SECTIONS[current.type].label : currentBlock ? (currentBlock.type === 'buttons' ? 'Buy buttons' : PRODUCT_BLOCKS[currentBlock.type].label) : FIXED[selected] ?? 'Settings'}
              </p>
              {current && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><button type="button" aria-label="Section actions" className="grid size-7 place-items-center rounded-md hover:bg-zinc-100 dark:hover:bg-black/[0.06]"><MoreHorizontal className="size-4" /></button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="z-[70]">
                    <DropdownMenuItem onClick={() => duplicate(current.id)}><Copy /> Duplicate</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setSections(sections.map((x) => (x.id === current.id ? { ...x, enabled: !x.enabled } : x)))}>{current.enabled ? <EyeOff /> : <Eye />} {current.enabled ? 'Hide' : 'Show'}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <button type="button" aria-label="Close" onClick={() => setSelected(null)} className="grid size-7 place-items-center rounded-md hover:bg-zinc-100 dark:hover:bg-black/[0.06]"><X className="size-4" /></button>
            </div>
            <fieldset disabled={!s.canEdit} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
              {current
                ? <>
                    {SECTIONS[current.type].fields.map((f) => <SchemaField key={f.key} field={f} settings={current.settings} onChange={(k, v) => setSectionSettings(current.id, k, v)} />)}
                    <button type="button" onClick={() => removeSection(current.id)} className="mx-auto flex items-center gap-1.5 pt-2 text-[13px] font-medium text-red-600 hover:underline"><Trash2 className="size-4" /> Remove section</button>
                  </>
                : currentBlock
                ? currentBlock.type === 'buttons'
                  ? <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">Quantity, “Add to cart” and “Buy it now”. Drag blocks above or below them in the list. Their look is set under Product information, or with the “Add to cart button” block.</p>
                  : <>
                      <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">{PRODUCT_BLOCKS[currentBlock.type].description}</p>
                      <FieldRow label="Show this block" inline>
                        <Switch checked={currentBlock.enabled} onCheckedChange={(v) => setBlocks(blocks.map((b) => (b.id === currentBlock.id ? { ...b, enabled: v } : b)))} />
                      </FieldRow>
                      {PRODUCT_BLOCKS[currentBlock.type].fields.map((f) => (
                        <SchemaField key={f.key} field={f} settings={currentBlock.settings}
                          onChange={(k, v) => setBlocks(blocks.map((b) => (b.id === currentBlock.id ? { ...b, settings: { ...b.settings, [k]: v } } : b)))} />
                      ))}
                      <button type="button" onClick={() => { setBlocks(blocks.filter((b) => b.id !== currentBlock.id)); setSelected(null) }}
                        className="mx-auto flex items-center gap-1.5 pt-2 text-[13px] font-medium text-red-600 hover:underline"><Trash2 className="size-4" /> Remove block</button>
                    </>
                : <FixedSettings id={selected} theme={theme} setTheme={setTheme} draft={draft} setSf={(k, v) => commit({ ...draft, [k]: v })} />}
            </fieldset>
          </aside>
        )}
      </div>
    </div>
  )
}

function IconButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active} disabled={disabled} onClick={onClick}
      className={cn('grid size-8 place-items-center rounded-lg text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-35 disabled:hover:bg-transparent dark:text-zinc-300 dark:hover:bg-black/[0.06] [&_svg]:size-4',
        active && 'bg-zinc-100 text-zinc-900 dark:bg-black/[0.08] dark:text-zinc-100')}>
      {children}
    </button>
  )
}

function TreeGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-zinc-200 px-2 py-2.5 last:border-0 dark:border-black/10">
      <p className="px-2 pb-1 text-xs font-semibold">{title}</p>
      {children}
    </div>
  )
}

function TreeItem({ icon, label, sub, active, hidden, onClick, actions, drag }: {
  icon: ReactNode; label: string; sub?: string; active: boolean; hidden?: boolean; onClick: () => void; actions?: ReactNode
  drag?: { onDragStart: () => void; onDragOver: (e: React.DragEvent) => void; onDrop: () => void; over: boolean }
}) {
  return (
    <div draggable={!!drag} onDragStart={drag?.onDragStart} onDragOver={drag?.onDragOver} onDrop={drag?.onDrop}
      // Selected: a light tint with dark text and a blue edge, readable whether the item is shown, hidden or being dragged.
      className={cn('group/item relative flex h-8 items-center gap-1.5 rounded-lg pr-1 pl-1.5 text-zinc-900 transition-colors dark:text-zinc-100',
        active ? 'bg-[#e8f0fe] font-medium shadow-[inset_3px_0_0_#2c6ecb] dark:bg-[#2c6ecb]/25' : 'hover:bg-zinc-100 dark:hover:bg-black/[0.06]',
        drag?.over && 'before:absolute before:inset-x-2 before:-top-px before:h-0.5 before:bg-[#2c6ecb]')}>
      <span className={cn('grid w-4 place-items-center text-zinc-500 opacity-0 group-hover/item:opacity-100', !drag && 'invisible')}><GripVertical className="size-3.5 cursor-grab" /></span>
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className={cn('shrink-0', active ? 'text-[#2c6ecb]' : 'text-zinc-500', hidden && 'opacity-60')}>{icon}</span>
        <span className={cn('min-w-0 truncate', hidden && 'text-zinc-500 line-through decoration-zinc-400')}>
          {label}{sub && <span className="ml-1 font-normal text-zinc-500 no-underline">{sub}</span>}
        </span>
        {hidden && <span className="shrink-0 rounded bg-zinc-200 px-1.5 text-[10px] font-medium text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">Hidden</span>}
      </button>
      {actions && <span className={cn('flex items-center text-zinc-600 opacity-0 group-hover/item:opacity-100 dark:text-zinc-300', (active || hidden) && 'opacity-100')}>{actions}</span>}
    </div>
  )
}

function SectionTree({ page, theme, sections, selected, onSelect, onSections, pickerOpen, setPickerOpen, onAdd, blocks, onBlocks, onAddBlock }: {
  page: Page; theme: StoreTheme; sections: ThemeSection[]; selected: string | null; onSelect: (id: string) => void; onSections: (s: ThemeSection[]) => void
  pickerOpen: boolean; setPickerOpen: (v: boolean) => void; onAdd: (t: SectionType) => void
  blocks: ProductBlock[]; onBlocks: (b: ProductBlock[]) => void; onAddBlock: (t: Exclude<ProductBlock['type'], 'buttons'>) => void
}) {
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [dragBlock, setDragBlock] = useState<number | null>(null)
  const [overBlock, setOverBlock] = useState<number | null>(null)
  const [blockPicker, setBlockPicker] = useState(false)
  const moveBlock = (from: number, to: number) => {
    const next = [...blocks]
    const [item] = next.splice(from, 1)
    next.splice(to > from ? to - 1 : to, 0, item)
    onBlocks(next)
  }
  // Blocks inside Product information: drag above or below the buy buttons, show or hide, add.
  const blockList = (
    <div className="ml-4 border-l border-zinc-200 pl-1.5 dark:border-black/10">
      {blocks.map((b, i) => {
        const label = b.type === 'buttons' ? 'Buy buttons' : PRODUCT_BLOCKS[b.type].label
        return (
          <TreeItem key={b.id} icon={BLOCK_ICON[b.type]} label={label} active={selected === `block:${b.id}`} hidden={!b.enabled} onClick={() => onSelect(`block:${b.id}`)}
            drag={{ onDragStart: () => setDragBlock(i), onDragOver: (e) => { e.preventDefault(); setOverBlock(i) },
              onDrop: () => { if (dragBlock !== null && dragBlock !== i) moveBlock(dragBlock, i); setDragBlock(null); setOverBlock(null) }, over: overBlock === i && dragBlock !== null && dragBlock !== i }}
            actions={b.type === 'buttons' ? undefined : (
              <button type="button" aria-label={b.enabled ? 'Hide block' : 'Show block'} className="grid size-6 place-items-center rounded hover:bg-black/10"
                onClick={() => onBlocks(blocks.map((x) => (x.id === b.id ? { ...x, enabled: !x.enabled } : x)))}>
                {b.enabled ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
              </button>
            )} />
        )
      })}
      <div onDragOver={(e) => { e.preventDefault(); setOverBlock(blocks.length) }} onDrop={() => { if (dragBlock !== null) moveBlock(dragBlock, blocks.length); setDragBlock(null); setOverBlock(null) }}
        className={cn('h-1 rounded', overBlock === blocks.length && dragBlock !== null && 'bg-[#2c6ecb]')} />
      <Popover open={blockPicker} onOpenChange={setBlockPicker}>
        <PopoverTrigger asChild>
          <button type="button" className="flex h-8 w-full items-center gap-2 rounded-lg px-2 font-medium text-[#2c6ecb] hover:bg-zinc-100 dark:hover:bg-black/[0.06]">
            <span className="grid size-4 place-items-center rounded-full border border-current"><Plus className="size-3" /></span> Add block
          </button>
        </PopoverTrigger>
        <PopoverContent side="right" align="start" sideOffset={8} className="z-[70] w-auto border-0 bg-transparent p-0 shadow-none">
          <BlockPicker has={(t) => blocks.some((b) => b.type === t)} onPick={(t) => { onAddBlock(t); setBlockPicker(false) }} />
        </PopoverContent>
      </Popover>
    </div>
  )
  const move = (from: number, to: number) => {
    const next = [...sections]
    const [item] = next.splice(from, 1)
    next.splice(to > from ? to - 1 : to, 0, item)
    onSections(next)
  }
  const headerItems = (
    <TreeGroup title="Header">
      <TreeItem icon={<PanelTop className="size-4" />} label="Announcement bar" active={selected === 'announcement'} hidden={!theme.announcement.enabled} onClick={() => onSelect('announcement')} />
      <TreeItem icon={<PanelTop className="size-4" />} label="Header" active={selected === 'header'} onClick={() => onSelect('header')} />
    </TreeGroup>
  )
  const footerItems = (
    <TreeGroup title="Footer">
      <TreeItem icon={<PanelBottom className="size-4" />} label="Footer" active={selected === 'footer'} onClick={() => onSelect('footer')} />
    </TreeGroup>
  )
  // Sections the merchant adds (home page, or under the product on product pages): drag, hide, add.
  const sectionList = (
    <>
      {sections.map((sec, i) => {
        const sub = typeof sec.settings.heading === 'string' && sec.settings.heading && sec.type !== 'hero' ? `: ${sec.settings.heading}` : undefined
        return (
          <TreeItem key={sec.id} icon={SECTION_ICON[sec.type]} label={SECTIONS[sec.type].label} sub={sub} active={selected === sec.id} hidden={!sec.enabled}
            onClick={() => onSelect(sec.id)}
            drag={{ onDragStart: () => setDragging(i), onDragOver: (e) => { e.preventDefault(); setOver(i) }, onDrop: () => { if (dragging !== null && dragging !== i) move(dragging, i); setDragging(null); setOver(null) }, over: over === i && dragging !== null && dragging !== i }}
            actions={
              <button type="button" aria-label={sec.enabled ? 'Hide section' : 'Show section'} className="grid size-6 place-items-center rounded hover:bg-black/10"
                onClick={() => onSections(sections.map((x) => (x.id === sec.id ? { ...x, enabled: !x.enabled } : x)))}>
                {sec.enabled ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
              </button>
            } />
        )
      })}
      <div onDragOver={(e) => { e.preventDefault(); setOver(sections.length) }} onDrop={() => { if (dragging !== null) move(dragging, sections.length); setDragging(null); setOver(null) }}
        className={cn('h-1 rounded', over === sections.length && dragging !== null && 'bg-[#2c6ecb]')} />
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="flex h-8 w-full items-center gap-2 rounded-lg px-2 font-medium text-[#2c6ecb] hover:bg-zinc-100 dark:hover:bg-black/[0.06]">
            <span className="grid size-4 place-items-center rounded-full border border-current"><Plus className="size-3" /></span> Add section
          </button>
        </PopoverTrigger>
        <PopoverContent side="right" align="start" sideOffset={8} className="z-[70] w-auto border-0 bg-transparent p-0 shadow-none">
          <SectionPicker onPick={onAdd} />
        </PopoverContent>
      </Popover>
    </>
  )
  return (
    <div>
      <p className="px-4 pt-3 pb-1 text-sm font-semibold">{PAGES.find((p) => p.value === page)?.label}</p>
      {headerItems}
      <TreeGroup title="Template">
        {page === 'home' ? sectionList
          : page === 'collection' ? (
            <>
              <TreeItem icon={<PanelTop className="size-4" />} label="Collection banner" active={selected === 'collection-banner'} hidden={!theme.collection.banner} onClick={() => onSelect('collection-banner')} />
              <TreeItem icon={<LayoutTemplate className="size-4" />} label="Product grid" active={selected === 'collection-grid'} onClick={() => onSelect('collection-grid')} />
            </>
          ) : page === 'product' ? (
            <>
              <TreeItem icon={<ShoppingBag className="size-4" />} label="Product information" active={selected === 'product-info'} onClick={() => onSelect('product-info')} />
              {blockList}
              <TreeItem icon={<LayoutTemplate className="size-4" />} label="Related products" sub={theme.product_page.related_title ? `: ${theme.product_page.related_title}` : undefined}
                active={selected === 'product-related'} hidden={!theme.product_page.show_related} onClick={() => onSelect('product-related')} />
              {sectionList}
            </>
          ) : (
            <>
              <TreeItem icon={<ShoppingCart className="size-4" />} label="Cart drawer" active={selected === 'cart-drawer'} onClick={() => onSelect('cart-drawer')} />
              <p className="px-2 py-1.5 text-xs leading-relaxed text-zinc-500">Opens when something is added. The cart page uses your theme colours and font.</p>
            </>
          )}
      </TreeGroup>
      {footerItems}
    </div>
  )
}

function FixedSettings({ id, theme, setTheme, draft, setSf }: { id: string; theme: StoreTheme; setTheme: (p: Partial<StoreTheme>) => void; draft: Storefront; setSf: (k: string, v: unknown) => void }) {
  const toLinks = (v: Array<Record<string, string>>): MenuLink[] => v.map((x) => ({ label: x.label ?? '', link: x.link ?? '' }))
  if (id === 'announcement') {
    const a = theme.announcement
    return (
      <>
        <FieldRow label="Show announcement bar" inline><Switch checked={a.enabled} onCheckedChange={(v) => setTheme({ announcement: { ...a, enabled: v } })} /></FieldRow>
        <FieldRow label="Scrolling (marquee)" inline><Switch checked={a.marquee} onCheckedChange={(v) => setTheme({ announcement: { ...a, marquee: v } })} /></FieldRow>
        <ListField label="Messages" item={[{ key: 'text', label: 'Message' }]} max={6} value={a.items.map((text) => ({ text }))}
          onChange={(v) => setTheme({ announcement: { ...a, items: v.map((x) => x.text ?? '') } })} />
        <FieldRow label="Background"><ColorInput value={theme.colors.announcement_bg} onChange={(v) => setTheme({ colors: { ...theme.colors, announcement_bg: v } })} /></FieldRow>
        <FieldRow label="Text"><ColorInput value={theme.colors.announcement_text} onChange={(v) => setTheme({ colors: { ...theme.colors, announcement_text: v } })} /></FieldRow>
      </>
    )
  }
  if (id === 'header') {
    const h = theme.header
    return (
      <>
        <FieldRow label="Logo position">
          <SelectInput value={theme.logo_position} onChange={(v) => setTheme({ logo_position: v as StoreTheme['logo_position'] })} options={[{ value: 'center', label: 'Center, menu on the left' }, { value: 'left', label: 'Left, menu beside it' }]} />
        </FieldRow>
        <FieldRow label="Sticky header" inline><Switch checked={h.sticky} onCheckedChange={(v) => setTheme({ header: { ...h, sticky: v } })} /></FieldRow>
        <FieldRow label="Uppercase menu" inline><Switch checked={h.uppercase} onCheckedChange={(v) => setTheme({ header: { ...h, uppercase: v } })} /></FieldRow>
        <FieldRow label="See-through over the hero" inline><Switch checked={h.transparent} onCheckedChange={(v) => setTheme({ header: { ...h, transparent: v } })} /></FieldRow>
        <ListField label="Menu" item={[{ key: 'label', label: 'Label' }, { key: 'link', label: 'Link, e.g. /collection/belts' }]} max={10}
          value={h.menu.map((m) => ({ label: m.label, link: m.link }))} onChange={(v) => setTheme({ header: { ...h, menu: toLinks(v) } })} />
        <p className="text-[11px] leading-snug text-zinc-500">Leave the menu empty to list your categories automatically, with sub-categories in a drop-down. The logo is set in Settings → Business profile.</p>
        <SchemaField field={{ key: 'favicon_url', label: 'Favicon (browser tab icon)', type: 'image', hint: 'A square image, at least 48 × 48 px. Empty uses the default icon.' }}
          settings={{ favicon_url: theme.favicon_url }} onChange={(_, v) => setTheme({ favicon_url: String(v ?? '') })} />
      </>
    )
  }
  if (id === 'footer') {
    const f = theme.footer
    return (
      <>
        <FieldRow label="Contact heading"><input className={inputClass} value={f.contact_title} onChange={(e) => setTheme({ footer: { ...f, contact_title: e.target.value } })} /></FieldRow>
        <FieldRow label="Contact details" hint="Empty uses your store e-mail, phone and address"><textarea rows={3} className={cn(inputClass, 'h-auto py-1.5')} value={f.contact_text} onChange={(e) => setTheme({ footer: { ...f, contact_text: e.target.value } })} /></FieldRow>
        <ListField label="Links" item={[{ key: 'label', label: 'Label' }, { key: 'link', label: 'Link' }]} max={10} value={f.links.map((m) => ({ label: m.label, link: m.link }))}
          onChange={(v) => setTheme({ footer: { ...f, links: toLinks(v) } })} />
        <FieldRow label="Show country and currency" inline><Switch checked={f.show_currency} onCheckedChange={(v) => setTheme({ footer: { ...f, show_currency: v } })} /></FieldRow>
        <FieldRow label="Payment methods" inline><Switch checked={theme.payment_badges} onCheckedChange={(v) => setTheme({ payment_badges: v })} /></FieldRow>
        <FieldRow label="Copyright text"><input className={inputClass} value={String(draft.footer_text ?? '')} placeholder={`© ${new Date().getFullYear()} Your store`} onChange={(e) => setSf('footer_text', e.target.value)} /></FieldRow>
        <FieldRow label="Background"><ColorInput value={theme.colors.footer_bg} onChange={(v) => setTheme({ colors: { ...theme.colors, footer_bg: v } })} /></FieldRow>
        <FieldRow label="Text"><ColorInput value={theme.colors.footer_text} onChange={(v) => setTheme({ colors: { ...theme.colors, footer_text: v } })} /></FieldRow>
      </>
    )
  }
  if (id === 'product-info') {
    const pp = theme.product_page
    const set = (patch: Partial<StoreTheme['product_page']>) => setTheme({ product_page: { ...pp, ...patch } })
    const toggle = (label: string, key: keyof StoreTheme['product_page'], hint?: string) => (
      <FieldRow label={label} hint={hint} inline><Switch checked={!!pp[key]} onCheckedChange={(v) => set({ [key]: v })} /></FieldRow>
    )
    const classic = pp.layout === 'classic'
    const rows = pp.accordions
    const setRow = (i: number, patch: Partial<ProductAccordion>) => set({ accordions: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
    const dayInput = (key: 'delivery_min_days' | 'delivery_max_days') => (
      <input type="number" min={0} max={30} className={inputClass} value={pp[key]} aria-label={key === 'delivery_min_days' ? 'Earliest day' : 'Latest day'}
        onChange={(e) => set({ [key]: Math.min(30, Math.max(0, Number(e.target.value) || 0)) })} />
    )
    return (
      <>
        <FieldRow label="Layout" hint={classic ? 'Photo with thumbnails in a box.' : pp.layout === 'bold' ? 'Edge-to-edge photo, name in italics, delivery timeline.' : 'Edge-to-edge photo, name and price in one row.'}>
          <SelectInput value={pp.layout} onChange={(v) => set({ layout: v as typeof pp.layout, ...(v === 'bold' ? { buy_now_style: 'filled', show_delivery: true } : v === 'minimal' ? { buy_now_style: 'outline' } : {}) })}
            options={[{ value: 'minimal', label: 'Minimal' }, { value: 'bold', label: 'Bold' }, { value: 'classic', label: 'Classic' }]} />
        </FieldRow>
        <FieldRow label="Image shape"><SelectInput value={pp.image_aspect} onChange={(v) => set({ image_aspect: v as typeof pp.image_aspect })} options={[{ value: 'portrait', label: 'Portrait (4:5)' }, { value: 'square', label: 'Square' }]} /></FieldRow>
        {toggle('Brand above the name', 'show_brand')}
        {toggle('“Sale” badge', 'show_sale_badge')}
        {toggle('Stock note', 'show_stock', '“5 left” / “In stock”. Out of stock always shows.')}
        <FieldRow label="Button corners"><RangeInput value={pp.button_radius} onChange={(v) => set({ button_radius: v })} min={0} max={24} unit="px" /></FieldRow>
        {toggle('Quantity selector', 'show_quantity')}
        {toggle('“Buy it now” button', 'show_buy_now')}
        {pp.show_buy_now && (
          <FieldRow label="“Buy it now” style">
            <SelectInput value={pp.buy_now_style} onChange={(v) => set({ buy_now_style: v as typeof pp.buy_now_style })} options={[{ value: 'outline', label: 'Outline' }, { value: 'filled', label: 'Filled' }]} />
          </FieldRow>
        )}
        {classic ? (
          <>
            {toggle('Description', 'show_description')}
            {pp.show_description && <FieldRow label="Description heading"><input className={inputClass} value={pp.description_title} placeholder="Description" onChange={(e) => set({ description_title: e.target.value })} /></FieldRow>}
            {toggle('Shipping and warranty', 'show_details')}
            {toggle('SKU', 'show_sku')}
            {toggle('Tags', 'show_tags')}
          </>
        ) : (
          <>
            {toggle('Delivery timeline', 'show_delivery', 'Purchased → Processing → Delivered, dated from today.')}
            {pp.show_delivery && (
              <FieldRow label="Delivered in (days)">
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">{dayInput('delivery_min_days')}<span className="text-zinc-500">to</span>{dayInput('delivery_max_days')}</div>
              </FieldRow>
            )}
            <ListField label="Highlights" item={[{ key: 'text', label: 'e.g. 600+ Happy Customers' }]} max={4} value={pp.highlights.map((text) => ({ text }))}
              onChange={(v) => set({ highlights: v.map((x) => x.text ?? '') })} />
            <FieldRow label="Note" hint="Put **stars** around words to make them bold.">
              <input className={inputClass} value={pp.promo_text} placeholder="Use code **SAVE3** to get **3% OFF**" onChange={(e) => set({ promo_text: e.target.value })} />
            </FieldRow>
            <FieldRow label="Accordion rows" hint="Rows with no text on a product are hidden on that product.">
              <div className="grid gap-2">
                {rows.map((row, i) => (
                  <div key={i} className="grid gap-1.5 rounded-lg border border-zinc-200 p-2 dark:border-black/10">
                    <input className={inputClass} aria-label={`Row ${i + 1} title`} placeholder="Title" value={row.title} onChange={(e) => setRow(i, { title: e.target.value })} />
                    <SelectInput value={row.content} onChange={(v) => setRow(i, { content: v as ProductAccordion['content'] })}
                      options={[{ value: 'description', label: 'Product description' }, { value: 'shipping', label: 'Product shipping note' }, { value: 'warranty', label: 'Product warranty / care' }, { value: 'custom', label: 'My own text' }]} />
                    {row.content === 'custom' && (
                      <textarea className={cn(inputClass, 'h-20 py-1.5')} aria-label={`Row ${i + 1} text`} placeholder="Same text on every product" value={row.text}
                        onChange={(e) => setRow(i, { text: e.target.value })} />
                    )}
                    <span className="flex items-center justify-end gap-3 text-[11px]">
                      {i > 0 && <button type="button" className="text-zinc-500 hover:underline" onClick={() => set({ accordions: [...rows.slice(0, i - 1), row, rows[i - 1], ...rows.slice(i + 1)] })}>Move up</button>}
                      <button type="button" className="flex items-center gap-1 text-red-600 hover:underline" onClick={() => set({ accordions: rows.filter((_, j) => j !== i) })}><Trash2 className="size-3" /> Remove</button>
                    </span>
                  </div>
                ))}
                {rows.length < 8 && (
                  <button type="button" onClick={() => set({ accordions: [...rows, { title: '', content: 'custom', text: '' }] })}
                    className="flex items-center gap-1.5 text-[13px] font-medium text-[#2c6ecb] hover:underline"><Plus className="size-3.5" /> Add row</button>
                )}
              </div>
            </FieldRow>
          </>
        )}
        <p className="text-[11px] leading-snug text-zinc-500">Photos, options, prices and text are set on each product.</p>
      </>
    )
  }
  if (id === 'cart-drawer') {
    const k = theme.cart
    const set = (patch: Partial<StoreTheme['cart']>) => setTheme({ cart: { ...k, ...patch } })
    return (
      <>
        <PanelGroup>Content</PanelGroup>
        <FieldRow label="Title"><input className={inputClass} value={k.title} placeholder="Cart" onChange={(e) => set({ title: e.target.value })} /></FieldRow>
        <FieldRow label="Free delivery progress bar" inline><Switch checked={k.free_shipping_bar} onCheckedChange={(v) => set({ free_shipping_bar: v })} /></FieldRow>
        {k.free_shipping_bar && (
          <>
            <FieldRow label="While below the amount" hint="{amount} is what is still missing. The amount is set in Settings → Delivery (free delivery over)."><input className={inputClass} value={k.free_shipping_text} onChange={(e) => set({ free_shipping_text: e.target.value })} /></FieldRow>
            <FieldRow label="When reached"><input className={inputClass} value={k.unlocked_text} onChange={(e) => set({ unlocked_text: e.target.value })} /></FieldRow>
          </>
        )}
        <FieldRow label="“You may also like” products" inline><Switch checked={k.upsell} onCheckedChange={(v) => set({ upsell: v })} /></FieldRow>
        {k.upsell && <FieldRow label="Heading"><input className={inputClass} value={k.upsell_title} onChange={(e) => set({ upsell_title: e.target.value })} /></FieldRow>}
        <FieldRow label="Show savings" inline><Switch checked={k.show_savings} onCheckedChange={(v) => set({ show_savings: v })} /></FieldRow>
        <FieldRow label="Note above the checkout button"><input className={inputClass} value={k.note} placeholder="e.g. Delivery in 1–3 days" onChange={(e) => set({ note: e.target.value })} /></FieldRow>
        <FieldRow label="“View cart” link" inline><Switch checked={k.show_view_cart} onCheckedChange={(v) => set({ show_view_cart: v })} /></FieldRow>
        <FieldRow label="Empty cart text"><input className={inputClass} value={k.empty_text} onChange={(e) => set({ empty_text: e.target.value })} /></FieldRow>

        <PanelGroup>Layout</PanelGroup>
        <FieldRow label="Opens from"><SelectInput value={k.side} onChange={(v) => set({ side: v as 'left' | 'right' })} options={[{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }]} /></FieldRow>
        <FieldRow label="Width on computers" hint="Phones always use the full width."><SelectInput value={k.width} onChange={(v) => set({ width: v as StoreTheme['cart']['width'] })}
          options={[{ value: 'narrow', label: 'Narrow (380 px)' }, { value: 'standard', label: 'Standard (420 px)' }, { value: 'wide', label: 'Wide (480 px)' }]} /></FieldRow>
        <FieldRow label="Spacing"><SelectInput value={k.spacing} onChange={(v) => set({ spacing: v as StoreTheme['cart']['spacing'] })}
          options={[{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }, { value: 'spacious', label: 'Spacious' }]} /></FieldRow>
        <FieldRow label="Product photos"><SelectInput value={k.image_shape} onChange={(v) => set({ image_shape: v as 'square' | 'portrait' })}
          options={[{ value: 'square', label: 'Square' }, { value: 'portrait', label: 'Portrait' }]} /></FieldRow>
        <FieldRow label="Photo size"><RangeInput value={k.image_size} min={CART_IMAGE_SIZE.min} max={CART_IMAGE_SIZE.max} step={4} unit="px" onChange={(v) => set({ image_size: v })} /></FieldRow>
        <FieldRow label="Photo corners"><RangeInput value={k.image_radius} min={0} max={24} unit="px" onChange={(v) => set({ image_radius: v })} /></FieldRow>
        <FieldRow label="Quantity box corners"><RangeInput value={k.stepper_radius} min={0} max={24} unit="px" onChange={(v) => set({ stepper_radius: v })} /></FieldRow>

        <PanelGroup>Colours</PanelGroup>
        <FieldRow label="Background"><ThemeColor value={k.background} fallback={theme.colors.background} onChange={(v) => set({ background: v })} /></FieldRow>
        <FieldRow label="Text"><ThemeColor value={k.text} fallback={theme.colors.text} onChange={(v) => set({ text: v })} /></FieldRow>
        {k.free_shipping_bar && <FieldRow label="Progress bar"><ThemeColor value={k.bar_color} fallback={k.text || theme.colors.text} onChange={(v) => set({ bar_color: v })} /></FieldRow>}

        <PanelGroup>Text</PanelGroup>
        <FieldRow label="Title size"><SelectInput value={k.title_size} onChange={(v) => set({ title_size: v as StoreTheme['cart']['title_size'] })}
          options={[{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }]} /></FieldRow>
        <FieldRow label="Title in capitals" inline><Switch checked={k.title_uppercase} onCheckedChange={(v) => set({ title_uppercase: v })} /></FieldRow>
        <FieldRow label="Text size" hint="Of the theme's text size (Theme settings → Typography)."><RangeInput value={k.text_scale} min={CART_TEXT_SCALE.min} max={CART_TEXT_SCALE.max} step={5} unit="%" onChange={(v) => set({ text_scale: v })} /></FieldRow>

        <PanelGroup>Checkout button</PanelGroup>
        <FieldRow label="Label"><input className={inputClass} value={k.button_label} placeholder="Checkout" onChange={(e) => set({ button_label: e.target.value })} /></FieldRow>
        <FieldRow label="Show the total" inline><Switch checked={k.button_show_total} onCheckedChange={(v) => set({ button_show_total: v })} /></FieldRow>
        <FieldRow label="Lock icon" inline><Switch checked={k.button_lock_icon} onCheckedChange={(v) => set({ button_lock_icon: v })} /></FieldRow>
        <FieldRow label="Button colour"><ThemeColor value={k.button_bg} fallback={theme.accent} onChange={(v) => set({ button_bg: v })} /></FieldRow>
        <FieldRow label="Button text" hint="Empty: white or black, whichever reads on the button."><ThemeColor value={k.button_text} fallback={onColor(k.button_bg || theme.accent)} onChange={(v) => set({ button_text: v })} /></FieldRow>
        <FieldRow label="Button corners"><RangeInput value={k.button_radius} min={0} max={28} unit="px" onChange={(v) => set({ button_radius: v })} /></FieldRow>
        <p className="text-[11px] leading-snug text-zinc-500">The drawer stays open in the preview while it is selected. With an empty cart it shows two sample products.</p>
      </>
    )
  }
  if (id === 'product-related') {
    const pp = theme.product_page
    return (
      <>
        <FieldRow label="Show related products" inline><Switch checked={pp.show_related} onCheckedChange={(v) => setTheme({ product_page: { ...pp, show_related: v } })} /></FieldRow>
        <FieldRow label="Heading"><input className={inputClass} value={pp.related_title} placeholder="You may also like" onChange={(e) => setTheme({ product_page: { ...pp, related_title: e.target.value } })} /></FieldRow>
        <p className="text-[11px] leading-snug text-zinc-500">Products from the same category.</p>
      </>
    )
  }
  if (id === 'collection-banner' || id === 'collection-grid') {
    const c = theme.collection
    return (
      <>
        <FieldRow label="Show the collection banner" inline><Switch checked={c.banner} onCheckedChange={(v) => setTheme({ collection: { ...c, banner: v } })} /></FieldRow>
        <p className="text-[11px] leading-snug text-zinc-500">The banner uses the category's image, set on the category.</p>
        <FieldRow label="Products per row on desktop"><RangeInput value={c.columns} min={2} max={5} onChange={(v) => setTheme({ collection: { ...c, columns: v as 2 | 3 | 4 | 5 } })} /></FieldRow>
      </>
    )
  }
  return null
}

function Accordion({ title, children, defaultOpen }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div className="border-b border-zinc-200 dark:border-black/10">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex h-11 w-full items-center justify-between px-4 font-medium hover:bg-zinc-50 dark:hover:bg-black/[0.06]">
        {title}<ChevronDown className={cn('size-4 text-zinc-500 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="space-y-4 px-4 pb-4">{children}</div>}
    </div>
  )
}

/** How the two fonts and sizes look together (the store preview shows the real thing). */
function TypeSample({ theme }: { theme: StoreTheme }) {
  useThemeFont(theme.font, theme.heading_font)
  const weight = theme.heading_weight === 'default' ? 600 : Number(theme.heading_weight)
  return (
    <div className="space-y-1 rounded-lg border border-[#e4e4e7] bg-white p-3 text-[#18181b]">
      <p style={{ fontFamily: FONTS[theme.heading_font].family, fontWeight: weight, fontSize: `${1.25 * theme.heading_size / 100}rem` }} className="leading-tight">Summer linen shirt</p>
      <p style={{ fontFamily: FONTS[theme.font].family, fontSize: `${0.875 * theme.text_size / 100}rem` }} className="leading-snug text-[#52525b]">Breathable cotton-linen, cut for the heat. ৳1,250 · ক্যাশ অন ডেলিভারি</p>
    </div>
  )
}

function ThemeSettings({ theme, setTheme }: { theme: StoreTheme; setTheme: (p: Partial<StoreTheme>) => void }) {
  const c = theme.colors
  const pc = theme.product_card
  return (
    <div>
      <p className="px-4 pt-3 pb-2 text-sm font-semibold">Theme settings</p>
      <Accordion title="Logo" >
        <FieldRow label="Logo position"><SelectInput value={theme.logo_position} onChange={(v) => setTheme({ logo_position: v as StoreTheme['logo_position'] })} options={[{ value: 'center', label: 'Center' }, { value: 'left', label: 'Left' }]} /></FieldRow>
        <p className="text-[11px] text-zinc-500">Upload the logo in Settings → Business profile.</p>
      </Accordion>
      <Accordion title="Colors" defaultOpen>
        <FieldRow label="Buttons and accents">
          <div className="flex flex-wrap gap-1.5">
            {ACCENTS.map((a) => (
              <button key={a} type="button" aria-label={`Colour ${a}`} aria-pressed={theme.accent === a} onClick={() => setTheme({ accent: a })}
                className={cn('size-6 rounded-full ring-offset-2 transition-transform hover:scale-110', theme.accent === a && 'ring-2 ring-zinc-900')} style={{ background: a }} />
            ))}
          </div>
          <ColorInput value={theme.accent} onChange={(v) => setTheme({ accent: v })} />
        </FieldRow>
        <FieldRow label="Background"><ColorInput value={c.background} onChange={(v) => setTheme({ colors: { ...c, background: v } })} /></FieldRow>
        <FieldRow label="Text"><ColorInput value={c.text} onChange={(v) => setTheme({ colors: { ...c, text: v } })} /></FieldRow>
        <FieldRow label="Footer background"><ColorInput value={c.footer_bg} onChange={(v) => setTheme({ colors: { ...c, footer_bg: v } })} /></FieldRow>
      </Accordion>
      <Accordion title="Typography" defaultOpen>
        <FieldRow label="Headings font"><FontPicker label="Headings font" value={theme.heading_font} onChange={(f) => setTheme({ heading_font: f })} /></FieldRow>
        <FieldRow label="Heading weight">
          <SelectInput value={theme.heading_weight} onChange={(v) => setTheme({ heading_weight: v as StoreTheme['heading_weight'] })} options={HEADING_WEIGHTS} />
        </FieldRow>
        <FieldRow label="Heading size"><RangeInput value={theme.heading_size} min={HEADING_SIZE.min} max={HEADING_SIZE.max} step={5} unit="%" onChange={(v) => setTheme({ heading_size: v })} /></FieldRow>
        <div className="h-px bg-zinc-200 dark:bg-black/10" />
        <FieldRow label="Body font"><FontPicker label="Body font" value={theme.font} onChange={(f) => setTheme({ font: f })} /></FieldRow>
        <FieldRow label="Body text size" hint="Also buttons, prices and menus."><RangeInput value={theme.text_size} min={TEXT_SIZE.min} max={TEXT_SIZE.max} step={5} unit="%" onChange={(v) => setTheme({ text_size: v })} /></FieldRow>
        <TypeSample theme={theme} />
        {(theme.text_size !== 100 || theme.heading_size !== 100) && (
          <button type="button" onClick={() => setTheme({ text_size: 100, heading_size: 100 })} className="text-xs font-medium text-[#2c6ecb] hover:underline">Reset sizes to 100%</button>
        )}
      </Accordion>
      <Accordion title="Buttons and corners">
        <div className="grid grid-cols-3 gap-2">
          {Object.entries(RADII).map(([k, r]) => (
            <button key={k} type="button" aria-pressed={theme.radius === k} onClick={() => setTheme({ radius: k as StoreTheme['radius'] })}
              className={cn('grid justify-items-center gap-1.5 rounded-lg border px-2 py-2.5', theme.radius === k ? 'border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-black/[0.05]' : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700')}>
              <span className="h-5 w-10 border-2 border-current" style={{ borderRadius: r.value }} /><span className="text-[11px] text-zinc-500">{r.label}</span>
            </button>
          ))}
        </div>
      </Accordion>
      <Accordion title="Product cards">
        <FieldRow label="Image shape"><SelectInput value={pc.aspect} onChange={(v) => setTheme({ product_card: { ...pc, aspect: v as typeof pc.aspect } })} options={[{ value: 'portrait', label: 'Portrait (4:5)' }, { value: 'square', label: 'Square' }]} /></FieldRow>
        <FieldRow label="Spacing"><SelectInput value={pc.gap} onChange={(v) => setTheme({ product_card: { ...pc, gap: v as typeof pc.gap } })} options={[{ value: 'none', label: 'Edge to edge' }, { value: 'small', label: 'Hairline' }, { value: 'large', label: 'Roomy' }]} /></FieldRow>
        <FieldRow label="Image background"><ColorInput value={pc.image_bg} onChange={(v) => setTheme({ product_card: { ...pc, image_bg: v } })} /></FieldRow>
        <FieldRow label="Uppercase names" inline><Switch checked={pc.uppercase} onCheckedChange={(v) => setTheme({ product_card: { ...pc, uppercase: v } })} /></FieldRow>
        <FieldRow label="“Sale” badge" inline><Switch checked={pc.sale_badge} onCheckedChange={(v) => setTheme({ product_card: { ...pc, sale_badge: v } })} /></FieldRow>
      </Accordion>
      <Accordion title="Chat button">
        <FieldRow label="WhatsApp chat button" inline><Switch checked={!!theme.whatsapp} onCheckedChange={(v) => setTheme({ whatsapp: v ? '01' : '' })} /></FieldRow>
        {!!theme.whatsapp && <input className={inputClass} inputMode="tel" value={theme.whatsapp} onChange={(e) => setTheme({ whatsapp: e.target.value })} placeholder="01XXXXXXXXX" />}
        <p className="text-[11px] text-zinc-500">A “Chat” button on every page opens WhatsApp with your number.</p>
      </Accordion>
      <Accordion title="Collection page">
        <FieldRow label="Banner with the category image" inline><Switch checked={theme.collection.banner} onCheckedChange={(v) => setTheme({ collection: { ...theme.collection, banner: v } })} /></FieldRow>
        <FieldRow label="Products per row"><RangeInput value={theme.collection.columns} min={2} max={5} onChange={(v) => setTheme({ collection: { ...theme.collection, columns: v as 2 | 3 | 4 | 5 } })} /></FieldRow>
      </Accordion>
    </div>
  )
}

/** A heading between groups of settings in the right-hand panel. */
function PanelGroup({ children }: { children: ReactNode }) {
  return <p className="border-t border-zinc-200 pt-3 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase first:border-0 first:pt-0 dark:border-black/10">{children}</p>
}

/** A colour that follows the theme until one is picked; "Use theme colour" goes back. */
function ThemeColor({ value, fallback, onChange }: { value: string; fallback: string; onChange: (v: string) => void }) {
  return (
    <div className="grid gap-1">
      <ColorInput value={value || fallback} onChange={onChange} />
      {value ? <button type="button" onClick={() => onChange('')} className="justify-self-start text-[11px] text-[#2c6ecb] hover:underline">Use theme colour</button>
        : <span className="text-[11px] text-zinc-500">Theme colour</span>}
    </div>
  )
}
