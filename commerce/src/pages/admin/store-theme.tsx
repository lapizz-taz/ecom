import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft, ChevronDown, Copy, Eye, EyeOff, GripVertical, Home, LayoutTemplate, Maximize2, Monitor, MoreHorizontal, MousePointerClick,
  Package, Paintbrush, PanelBottom, PanelTop, Plus, Redo2, ShoppingBag, ShoppingCart, Smartphone, Store, Trash2, Undo2, X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { Spinner } from '@/components/common/states'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { useSettingDraft } from '@/features/settings/setting-form'
import {
  ACCENTS, DEFAULT_THEME, FONTS, makeSection, RADII, resolveTheme, SECTIONS, type MenuLink, type SectionType, type StoreTheme, type Storefront, type ThemeSection,
} from '@/features/storefront/theme'
import { ColorInput, FieldRow, inputClass, ListField, RangeInput, SchemaField, SelectInput } from '@/features/theme-editor/fields'
import { SECTION_ICON, SectionPicker } from '@/features/theme-editor/section-picker'
import { useStoreConfig } from '@/hooks/use-store-config'
import { cn } from '@/lib/utils'
import { getCategories, listProducts } from '@/services/storefront'
import { useStoreAddress } from '@/hooks/use-store-address'

type Tab = 'sections' | 'settings'
type Page = 'home' | 'collection' | 'product' | 'cart'
const FIXED: Record<string, string> = {
  announcement: 'Announcement bar', header: 'Header', footer: 'Footer', 'collection-banner': 'Collection banner', 'collection-grid': 'Product grid',
  'product-info': 'Product information', 'product-related': 'Related products',
}
const PAGES: Array<{ value: Page; label: string; icon: ReactNode }> = [
  { value: 'home', label: 'Home page', icon: <Home className="size-3.5" /> },
  { value: 'collection', label: 'Collections', icon: <LayoutTemplate className="size-3.5" /> },
  { value: 'product', label: 'Products', icon: <Package className="size-3.5" /> },
  { value: 'cart', label: 'Cart', icon: <ShoppingCart className="size-3.5" /> },
]

/** The theme editor: sections and theme settings on the left, the live store in the middle, the selected item's settings on the right. */
export default function StoreThemePage() {
  const s = useSettingDraft('storefront')
  const navigate = useNavigate()
  const { data: config } = useStoreConfig()
  const frame = useRef<HTMLIFrameElement>(null)
  const [tab, setTab] = useState<Tab>('sections')
  const [page, setPage] = useState<Page>('home')
  const [selected, setSelected] = useState<string | null>(null)
  const [device, setDevice] = useState<'desktop' | 'mobile' | 'full'>('desktop')
  const [inspect, setInspect] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const history = useRef<{ past: Storefront[]; future: Storefront[]; last: number }>({ past: [], future: [], last: 0 })
  const [, bump] = useState(0)
  const draft = s.draft as Storefront | undefined
  const theme = useMemo(() => resolveTheme(draft), [draft])

  const categories = useQuery({ queryKey: ['storefront-categories'], queryFn: getCategories, staleTime: 10 * 60_000 })
  const firstProduct = useQuery({ queryKey: ['products', 'editor-first'], queryFn: () => listProducts({ limit: 1, sort: 'newest' }), staleTime: 5 * 60_000 })
  const firstCategory = categories.data?.find((c) => c.product_count > 0)?.slug
  // The preview opens the store under /s/<name> on this site (same origin, so the editor can talk to it).
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
      if (e.data?.type === 'theme-section-click') { setSelected(e.data.id); setTab('sections') }
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
  const duplicate = (id: string) => {
    const i = sections.findIndex((x) => x.id === id)
    const copy = { ...makeSection(sections[i].type), settings: structuredClone(sections[i].settings) }
    setSections([...sections.slice(0, i + 1), copy, ...sections.slice(i + 1)])
    setSelected(copy.id)
  }
  const exit = () => { if (!s.dirty || window.confirm('Leave without saving your changes?')) navigate('/admin/store/sales-channels') }
  const h = history.current
  const current = sections.find((x) => x.id === selected)

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[#f1f1f1] text-[13px] text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-zinc-200 bg-white px-2 dark:border-zinc-800 dark:bg-zinc-900">
        <IconButton label="Exit" onClick={exit}><ArrowLeft /></IconButton>
        <div className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-800" />
        <IconButton label="Sections" active={tab === 'sections'} onClick={() => setTab('sections')}><PanelTop /></IconButton>
        <IconButton label="Theme settings" active={tab === 'settings'} onClick={() => setTab('settings')}><Paintbrush /></IconButton>

        <div className="mx-auto flex min-w-0 items-center gap-2">
          <span className="hidden items-center gap-1.5 font-medium sm:flex"><Store className="size-3.5 text-zinc-500" />{config?.store.name ?? 'Store'}</span>
          <span className="hidden rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800 sm:inline dark:bg-emerald-500/15 dark:text-emerald-300">Active</span>
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800">
              {PAGES.find((p) => p.value === page)?.icon}{PAGES.find((p) => p.value === page)?.label}<ChevronDown className="size-3.5 text-zinc-500" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="z-[70] w-48">
              {PAGES.map((p) => <DropdownMenuItem key={p.value} onClick={() => { setPage(p.value); setSelected(null) }}>{p.icon}{p.label}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <IconButton label={inspect ? 'Inspector on: click the preview to select' : 'Inspector off'} active={inspect} onClick={() => setInspect(!inspect)}><MousePointerClick /></IconButton>
        <div className="hidden items-center sm:flex">
          <IconButton label="Desktop" active={device === 'desktop'} onClick={() => setDevice('desktop')}><Monitor /></IconButton>
          <IconButton label="Mobile" active={device === 'mobile'} onClick={() => setDevice('mobile')}><Smartphone /></IconButton>
          <IconButton label="Full width" active={device === 'full'} onClick={() => setDevice('full')}><Maximize2 /></IconButton>
        </div>
        <div className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-800" />
        <IconButton label="Undo" disabled={!h.past.length} onClick={undo}><Undo2 /></IconButton>
        <IconButton label="Redo" disabled={!h.future.length} onClick={redo}><Redo2 /></IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" aria-label="More" className="grid size-8 place-items-center rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 [&_svg]:size-4"><MoreHorizontal /></button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="z-[70] w-52">
            <DropdownMenuItem asChild disabled={!store.url}><a href={store.url ?? undefined} target="_blank" rel="noreferrer">View store</a></DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!s.dirty} onClick={() => { s.reset(); history.current = { past: [], future: [], last: 0 }; bump((n) => n + 1) }}>Discard changes</DropdownMenuItem>
            <DropdownMenuItem onClick={() => { if (window.confirm('Reset the theme to the default look? You can still discard before saving.')) commit({ ...draft, theme: structuredClone(DEFAULT_THEME) as unknown as Record<string, unknown> }) }}>Reset to default theme</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button type="button" onClick={() => s.save.mutate()} disabled={!s.dirty || !s.canEdit || s.save.isPending}
          className="ml-1 flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 text-[13px] font-medium text-white shadow-[inset_0_-1px_0_rgb(255_255_255/.15)] transition-opacity disabled:bg-zinc-200 disabled:text-zinc-500 dark:bg-white dark:text-zinc-900 dark:disabled:bg-zinc-800">
          {s.save.isPending && <Spinner className="size-3.5" />} Save
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Left panel */}
        <aside className="max-h-[42vh] shrink-0 overflow-y-auto border-b border-zinc-200 bg-white lg:max-h-none lg:w-[300px] lg:border-r lg:border-b-0 dark:border-zinc-800 dark:bg-zinc-900">
          <fieldset disabled={!s.canEdit} className="contents">
            {tab === 'sections' && (
              <SectionTree page={page} theme={theme} sections={sections} selected={selected} onSelect={setSelected} onSections={setSections}
                pickerOpen={pickerOpen} setPickerOpen={setPickerOpen} onAdd={addSection} />
            )}
            {tab === 'settings' && <ThemeSettings theme={theme} setTheme={setTheme} />}
          </fieldset>
        </aside>

        {/* Preview */}
        <div className="min-h-[50vh] min-w-0 flex-1 overflow-auto p-2 lg:p-3">
          <div className={cn('mx-auto h-full overflow-hidden rounded-lg bg-white shadow-[0_0_0_1px_rgb(0_0_0/.08),0_4px_16px_rgb(0_0_0/.06)] transition-[width] duration-300',
            device === 'mobile' ? 'w-[390px]' : device === 'full' ? 'w-full' : 'w-full max-w-[1400px]')}>
            <iframe ref={frame} key={path} title="Store preview" src={`${store.path ?? ''}${path}${path.includes('?') ? '&' : '?'}theme_preview=1`} className="size-full min-h-[50vh]"
              onLoad={() => post({ type: 'theme-preview', storefront: draft, selected, inspect })} />
          </div>
        </div>

        {/* Right panel: the selected item's settings */}
        {selected && (
          <aside className="absolute inset-y-0 right-0 z-10 flex w-full max-w-[320px] flex-col border-l border-zinc-200 bg-white shadow-xl lg:static lg:w-[300px] lg:shadow-none dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
              <span className="text-zinc-500">{current ? SECTION_ICON[current.type] : <PanelBottom className="size-4" />}</span>
              <p className="min-w-0 flex-1 truncate font-semibold">{current ? SECTIONS[current.type].label : FIXED[selected] ?? 'Settings'}</p>
              {current && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><button type="button" aria-label="Section actions" className="grid size-7 place-items-center rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800"><MoreHorizontal className="size-4" /></button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="z-[70]">
                    <DropdownMenuItem onClick={() => duplicate(current.id)}><Copy /> Duplicate</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setSections(sections.map((x) => (x.id === current.id ? { ...x, enabled: !x.enabled } : x)))}>{current.enabled ? <EyeOff /> : <Eye />} {current.enabled ? 'Hide' : 'Show'}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <button type="button" aria-label="Close" onClick={() => setSelected(null)} className="grid size-7 place-items-center rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800"><X className="size-4" /></button>
            </div>
            <fieldset disabled={!s.canEdit} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
              {current
                ? <>
                    {SECTIONS[current.type].fields.map((f) => <SchemaField key={f.key} field={f} settings={current.settings} onChange={(k, v) => setSectionSettings(current.id, k, v)} />)}
                    <button type="button" onClick={() => removeSection(current.id)} className="mx-auto flex items-center gap-1.5 pt-2 text-[13px] font-medium text-red-600 hover:underline"><Trash2 className="size-4" /> Remove section</button>
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
      className={cn('grid size-8 place-items-center rounded-lg text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-35 disabled:hover:bg-transparent dark:text-zinc-300 dark:hover:bg-zinc-800 [&_svg]:size-4',
        active && 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-white')}>
      {children}
    </button>
  )
}

function TreeGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-zinc-200 px-2 py-2.5 last:border-0 dark:border-zinc-800">
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
      className={cn('group/item relative flex h-8 items-center gap-1.5 rounded-lg pr-1 pl-1.5 transition-colors',
        active ? 'bg-[#2c6ecb] text-white' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800', drag?.over && 'before:absolute before:inset-x-2 before:-top-px before:h-0.5 before:bg-[#2c6ecb]')}>
      <span className={cn('grid w-4 place-items-center opacity-0 group-hover/item:opacity-60', !drag && 'invisible')}><GripVertical className="size-3.5 cursor-grab" /></span>
      <button type="button" onClick={onClick} className={cn('flex min-w-0 flex-1 items-center gap-2 text-left', hidden && 'opacity-50')}>
        <span className={cn('shrink-0', active ? 'text-white' : 'text-zinc-500')}>{icon}</span>
        <span className="min-w-0 truncate">{label}{sub && <span className={cn('ml-1', active ? 'text-white/75' : 'text-zinc-500')}>{sub}</span>}</span>
      </button>
      {actions && <span className={cn('flex items-center opacity-0 group-hover/item:opacity-100', active && 'opacity-100')}>{actions}</span>}
    </div>
  )
}

function SectionTree({ page, theme, sections, selected, onSelect, onSections, pickerOpen, setPickerOpen, onAdd }: {
  page: Page; theme: StoreTheme; sections: ThemeSection[]; selected: string | null; onSelect: (id: string) => void; onSections: (s: ThemeSection[]) => void
  pickerOpen: boolean; setPickerOpen: (v: boolean) => void; onAdd: (t: SectionType) => void
}) {
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
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
          <button type="button" className="flex h-8 w-full items-center gap-2 rounded-lg px-2 font-medium text-[#2c6ecb] hover:bg-zinc-100 dark:hover:bg-zinc-800">
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
              <TreeItem icon={<LayoutTemplate className="size-4" />} label="Related products" sub={theme.product_page.related_title ? `: ${theme.product_page.related_title}` : undefined}
                active={selected === 'product-related'} hidden={!theme.product_page.show_related} onClick={() => onSelect('product-related')} />
              {sectionList}
            </>
          ) : (
            <p className="px-2 py-1.5 text-xs leading-relaxed text-zinc-500">The cart uses your theme colours and font.</p>
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
    return (
      <>
        <FieldRow label="Image shape"><SelectInput value={pp.image_aspect} onChange={(v) => set({ image_aspect: v as typeof pp.image_aspect })} options={[{ value: 'portrait', label: 'Portrait (4:5)' }, { value: 'square', label: 'Square' }]} /></FieldRow>
        {toggle('Brand above the name', 'show_brand')}
        {toggle('“Sale” badge', 'show_sale_badge')}
        {toggle('Stock note', 'show_stock', '“Only 3 left” / “In stock”. Out of stock always shows.')}
        {toggle('Quantity selector', 'show_quantity')}
        {toggle('“Buy now” button', 'show_buy_now')}
        {toggle('Description', 'show_description')}
        {pp.show_description && <FieldRow label="Description heading"><input className={inputClass} value={pp.description_title} placeholder="Description" onChange={(e) => set({ description_title: e.target.value })} /></FieldRow>}
        {toggle('Shipping and warranty', 'show_details')}
        {toggle('SKU', 'show_sku')}
        {toggle('Tags', 'show_tags')}
        <p className="text-[11px] leading-snug text-zinc-500">Photos, options, prices and text are set on each product.</p>
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
    <div className="border-b border-zinc-200 dark:border-zinc-800">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex h-11 w-full items-center justify-between px-4 font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
        {title}<ChevronDown className={cn('size-4 text-zinc-500 transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="space-y-4 px-4 pb-4">{children}</div>}
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
      <Accordion title="Typography">
        <div className="grid grid-cols-3 gap-2">
          {Object.entries(FONTS).map(([k, f]) => (
            <button key={k} type="button" aria-pressed={theme.font === k} onClick={() => setTheme({ font: k as StoreTheme['font'] })}
              className={cn('grid justify-items-center gap-1 rounded-lg border px-2 py-2.5', theme.font === k ? 'border-zinc-900 bg-zinc-50 dark:border-white dark:bg-zinc-800' : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700')}>
              <span className="text-xl" style={{ fontFamily: f.family }}>{f.sample}</span><span className="text-[11px] text-zinc-500">{f.label}</span>
            </button>
          ))}
        </div>
      </Accordion>
      <Accordion title="Buttons and corners">
        <div className="grid grid-cols-3 gap-2">
          {Object.entries(RADII).map(([k, r]) => (
            <button key={k} type="button" aria-pressed={theme.radius === k} onClick={() => setTheme({ radius: k as StoreTheme['radius'] })}
              className={cn('grid justify-items-center gap-1.5 rounded-lg border px-2 py-2.5', theme.radius === k ? 'border-zinc-900 bg-zinc-50 dark:border-white dark:bg-zinc-800' : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700')}>
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
