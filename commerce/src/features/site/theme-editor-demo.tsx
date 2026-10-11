import { ArrowDown, ArrowUp, Eye, EyeOff, LayoutGrid, Monitor, Plus, Smartphone, Trash2 } from 'lucide-react'
import { useReducer, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { DEMO_PRODUCTS, HERO_IMAGES, type HeroImage } from './demo-data'

// The product site's theme editor: a working miniature of Store → Theme.
// Pick a section (in the list or the preview), change it on the right, and the
// preview follows. Everything stays in this component; nothing is saved.

type Kind = 'announcement' | 'header' | 'hero' | 'collections' | 'products' | 'richtext' | 'footer'

interface Section {
  id: string
  kind: Kind
  hidden: boolean
  s: Record<string, string | number | boolean>
}

const NAMES: Record<Kind, string> = {
  announcement: 'Announcement bar', header: 'Header', hero: 'Hero', collections: 'Collection list',
  products: 'New arrivals', richtext: 'Rich text', footer: 'Footer',
}

const DEFAULTS: Record<Kind, Section['s']> = {
  announcement: { text: 'FREE DELIVERY · CASH ON DELIVERY', tone: 'black' },
  header: { name: 'isolation', menu: 'Shop · Belts · Rings' },
  hero: { heading: 'Made to last.', button: 'Shop now', height: 150, image: 'stone' },
  collections: { title: 'Shop by category', columns: 3 },
  products: { title: 'New arrivals', count: 4, prices: true },
  richtext: { heading: 'Our story', body: 'Hand-finished in Dhaka and delivered across Bangladesh. Pay when it arrives.' },
  footer: { text: '© 2026 Isolation · Dhaka' },
}

const START: Kind[] = ['announcement', 'header', 'hero', 'collections', 'products', 'footer']
const ADDABLE: Kind[] = ['richtext', 'products', 'hero']

interface State { sections: Section[]; selected: string; seq: number }

type Action =
  | { type: 'select'; id: string }
  | { type: 'set'; id: string; key: string; value: string | number | boolean }
  | { type: 'toggle'; id: string }
  | { type: 'move'; id: string; by: -1 | 1 }
  | { type: 'add'; kind: Kind }
  | { type: 'remove'; id: string }

function reducer(state: State, a: Action): State {
  switch (a.type) {
    case 'select':
      return { ...state, selected: a.id }
    case 'set':
      return { ...state, sections: state.sections.map((x) => (x.id === a.id ? { ...x, s: { ...x.s, [a.key]: a.value } } : x)) }
    case 'toggle':
      return { ...state, sections: state.sections.map((x) => (x.id === a.id ? { ...x, hidden: !x.hidden } : x)) }
    case 'move': {
      const list = [...state.sections]
      const i = list.findIndex((x) => x.id === a.id)
      const j = i + a.by
      if (i < 0 || j < 0 || j >= list.length) return state
      ;[list[i], list[j]] = [list[j], list[i]]
      return { ...state, sections: list }
    }
    case 'add': {
      const id = `${a.kind}-${state.seq}`
      const footer = state.sections.findIndex((x) => x.kind === 'footer')
      const list = [...state.sections]
      list.splice(footer < 0 ? list.length : footer, 0, { id, kind: a.kind, hidden: false, s: { ...DEFAULTS[a.kind] } })
      return { sections: list, selected: id, seq: state.seq + 1 }
    }
    case 'remove': {
      const list = state.sections.filter((x) => x.id !== a.id)
      return { ...state, sections: list, selected: state.selected === a.id ? (list[0]?.id ?? '') : state.selected }
    }
  }
}

const initial = (): State => ({
  sections: START.map((k) => ({ id: k, kind: k, hidden: false, s: { ...DEFAULTS[k] } })),
  selected: 'hero',
  seq: 1,
})

const muted = 'text-[#8a8f98]'

export function ThemeEditorDemo() {
  const [state, dispatch] = useReducer(reducer, undefined, initial)
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const [adding, setAdding] = useState(false)
  const current = state.sections.find((x) => x.id === state.selected)
  const set = (key: string, value: string | number | boolean) => current && dispatch({ type: 'set', id: current.id, key, value })

  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#0f1011] text-[11px] shadow-[0_0_0_1px_rgb(0_0_0/.4),0_30px_80px_-20px_rgb(0_0_0/.8)]">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <span className="text-[#f7f8f8]">Isolation · Theme</span>
        <span className="rounded-full border border-white/10 px-1.5 py-px text-[10px] text-[#4cb782]">Live preview</span>
        <div className="ml-auto flex rounded-md border border-white/10 p-0.5" role="radiogroup" aria-label="Preview size">
          {([['desktop', Monitor], ['mobile', Smartphone]] as const).map(([d, Icon]) => (
            <button key={d} type="button" role="radio" aria-checked={device === d} aria-label={d === 'desktop' ? 'Desktop' : 'Phone'} onClick={() => setDevice(d)}
              className={cn('grid size-6 place-items-center rounded', device === d ? 'bg-white/10 text-white' : muted)}><Icon className="size-3.5" /></button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[170px_minmax(0,1fr)_200px]">
        {/* Sections */}
        <div className="border-b border-white/[0.06] p-2.5 lg:border-r lg:border-b-0">
          <p className="mb-1.5 px-1 text-[#f7f8f8]">Home page</p>
          <ul className="flex gap-1 overflow-x-auto lg:block lg:space-y-0.5 [scrollbar-width:none]">
            {state.sections.map((x, i) => (
              <li key={x.id} className="group relative shrink-0">
                <button type="button" onClick={() => dispatch({ type: 'select', id: x.id })} aria-pressed={x.id === state.selected}
                  className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                    x.id === state.selected ? 'bg-[#2142e7] text-white' : 'text-[#8a8f98] hover:bg-white/[0.05] hover:text-[#d0d6e0]', x.hidden && 'opacity-50')}>
                  <LayoutGrid className="size-3 shrink-0" /><span className="truncate">{NAMES[x.kind]}</span>
                </button>
                <span className="absolute top-1/2 right-1 hidden -translate-y-1/2 items-center gap-0.5 lg:group-hover:flex">
                  <IconBtn label="Move up" disabled={i === 0} onClick={() => dispatch({ type: 'move', id: x.id, by: -1 })}><ArrowUp /></IconBtn>
                  <IconBtn label="Move down" disabled={i === state.sections.length - 1} onClick={() => dispatch({ type: 'move', id: x.id, by: 1 })}><ArrowDown /></IconBtn>
                  <IconBtn label={x.hidden ? 'Show' : 'Hide'} onClick={() => dispatch({ type: 'toggle', id: x.id })}>{x.hidden ? <EyeOff /> : <Eye />}</IconBtn>
                </span>
              </li>
            ))}
            <li className="relative shrink-0">
              <button type="button" onClick={() => setAdding(!adding)} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[#7b8fff] hover:bg-white/[0.04]"><Plus className="size-3" /> Add section</button>
              {adding && (
                <div className="absolute top-full left-0 z-10 mt-1 w-36 rounded-lg border border-white/10 bg-[#16171a] p-1 shadow-xl">
                  {ADDABLE.map((k) => (
                    <button key={k} type="button" onClick={() => { dispatch({ type: 'add', kind: k }); setAdding(false) }}
                      className="block w-full rounded-md px-2 py-1.5 text-left text-[#d0d6e0] hover:bg-white/[0.06]">{NAMES[k]}</button>
                  ))}
                </div>
              )}
            </li>
          </ul>
        </div>

        {/* Preview */}
        <div className="bg-[#1a1b1e] p-3">
          <div className={cn('mx-auto overflow-hidden bg-white transition-[max-width] duration-500', device === 'mobile' ? 'max-w-[280px] rounded-[18px] ring-4 ring-black' : 'max-w-full')}>
            {state.sections.filter((x) => !x.hidden).map((x) => (
              <Block key={x.id} name={NAMES[x.kind]} active={x.id === state.selected} onSelect={() => dispatch({ type: 'select', id: x.id })}>
                <Render section={x} mobile={device === 'mobile'} />
              </Block>
            ))}
          </div>
        </div>

        {/* Settings */}
        <div className="space-y-2.5 border-t border-white/[0.06] p-3 lg:border-t-0 lg:border-l">
          {current ? (
            <>
              <div className="flex items-center gap-2">
                <p className="text-[#f7f8f8]">{NAMES[current.kind]}</p>
                {!START.includes(current.id as Kind) && (
                  <button type="button" aria-label="Remove section" onClick={() => dispatch({ type: 'remove', id: current.id })} className="ml-auto text-[#8a8f98] hover:text-[#eb5757]"><Trash2 className="size-3.5" /></button>
                )}
              </div>
              <Settings section={current} set={set} />
              <label className="flex items-center gap-2 pt-1 text-[#8a8f98]">
                <input type="checkbox" checked={!current.hidden} onChange={() => dispatch({ type: 'toggle', id: current.id })} className="accent-[#2142e7]" /> Show on the page
              </label>
            </>
          ) : <p className={muted}>Choose a section</p>}
        </div>
      </div>
    </div>
  )
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={(e) => { e.stopPropagation(); onClick() }}
      className="grid size-5 place-items-center rounded bg-black/40 text-white/80 hover:text-white disabled:opacity-30 [&_svg]:size-3">{children}</button>
  )
}

function Block({ name, active, onSelect, children }: { name: string; active: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <div role="button" tabIndex={0} aria-label={`Edit ${name}`} onClick={onSelect} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
      className={cn('relative cursor-pointer outline-none', active ? 'z-[1] ring-2 ring-[#2142e7] ring-inset' : 'hover:ring-1 hover:ring-[#2142e7]/50 hover:ring-inset focus-visible:ring-2 focus-visible:ring-[#2142e7]/60 focus-visible:ring-inset')}>
      {active && <span className="absolute top-0 left-0 z-[2] bg-[#2142e7] px-1.5 text-[9px] text-white">{name}</span>}
      {children}
    </div>
  )
}

const TONES: Record<string, string> = { black: 'bg-black text-white', blue: 'bg-[#2142e7] text-white', cream: 'bg-[#f4efe6] text-black' }

function Render({ section: x, mobile }: { section: Section; mobile: boolean }) {
  const s = x.s
  switch (x.kind) {
    case 'announcement':
      return <div className={cn('py-1.5 text-center text-[8px] tracking-[0.2em]', TONES[String(s.tone)])}>{String(s.text) || ' '}</div>
    case 'header':
      return (
        <div className="flex items-center justify-between px-3 py-2.5 text-[8px] tracking-wider text-black uppercase">
          <span className={cn(mobile && 'hidden')}>{String(s.menu)}</span>
          {mobile && <span className="text-[11px]">☰</span>}
          <span className="text-[12px] font-semibold tracking-normal normal-case">{String(s.name) || 'store'}</span>
          <span>⌕ ⛉</span>
        </div>
      )
    case 'hero': {
      const img = HERO_IMAGES[String(s.image) as HeroImage] ?? HERO_IMAGES.stone
      return (
        <div className={cn('relative flex items-end bg-gradient-to-br p-3 transition-[height] duration-300', img.className)} style={{ height: Number(s.height) * (mobile ? 0.9 : 1) }}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="bg-white px-3 py-1 text-[8px] tracking-wider text-black uppercase">{String(s.button) || 'Shop'}</span>
            <span className="text-[10px] font-medium text-white">{String(s.heading)}</span>
          </div>
        </div>
      )
    }
    case 'collections': {
      const cols = mobile ? 2 : Number(s.columns)
      return (
        <div className="px-3 py-3 text-black">
          <p className="mb-2 text-[10px] font-semibold">{String(s.title)}</p>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {['Belts', 'Rings', 'Bracelets', 'Chains'].slice(0, Math.max(cols, 2)).map((c, i) => (
              <div key={c} className={cn('flex aspect-[4/3] items-end bg-gradient-to-br p-1.5 text-[8px] font-medium text-white', DEMO_PRODUCTS[i % DEMO_PRODUCTS.length].tone)}>{c}</div>
            ))}
          </div>
        </div>
      )
    }
    case 'products':
      return (
        <div className="px-3 py-3 text-black">
          <p className="mb-2 text-[10px] font-semibold">{String(s.title)}</p>
          <div className={cn('grid gap-2', mobile ? 'grid-cols-2' : 'grid-cols-4')}>
            {DEMO_PRODUCTS.slice(0, Number(s.count)).map((p) => (
              <div key={p.name}>
                <div className={cn('aspect-[4/5] bg-gradient-to-br', p.tone)} />
                <p className="mt-1 truncate text-[8px]">{p.name}</p>
                {s.prices ? <p className="text-[8px] text-black/60">৳{p.price.toLocaleString('en-IN')}</p> : null}
              </div>
            ))}
          </div>
        </div>
      )
    case 'richtext':
      return (
        <div className="px-4 py-4 text-center text-black">
          <p className="text-[11px] font-semibold">{String(s.heading)}</p>
          <p className="mx-auto mt-1 max-w-xs text-[8px] leading-relaxed text-black/60">{String(s.body)}</p>
        </div>
      )
    case 'footer':
      return <div className="border-t border-black/10 px-3 py-2.5 text-[8px] text-black/60">{String(s.text)}</div>
  }
}

function Settings({ section: x, set }: { section: Section; set: (key: string, value: string | number | boolean) => void }) {
  const s = x.s
  switch (x.kind) {
    case 'announcement':
      return <>
        <Text label="Text" value={String(s.text)} onChange={(v) => set('text', v)} />
        <Chips label="Colour" value={String(s.tone)} options={[['black', 'Black'], ['blue', 'Blue'], ['cream', 'Cream']]} onChange={(v) => set('tone', v)} />
      </>
    case 'header':
      return <>
        <Text label="Store name" value={String(s.name)} onChange={(v) => set('name', v)} />
        <Text label="Menu" value={String(s.menu)} onChange={(v) => set('menu', v)} />
      </>
    case 'hero':
      return <>
        <Chips label="Image" value={String(s.image)} options={Object.entries(HERO_IMAGES).map(([k, v]) => [k, v.label])} onChange={(v) => set('image', v)} />
        <Text label="Heading" value={String(s.heading)} onChange={(v) => set('heading', v)} />
        <Text label="Button label" value={String(s.button)} onChange={(v) => set('button', v)} />
        <Range label="Height" value={Number(s.height)} min={90} max={220} onChange={(v) => set('height', v)} />
      </>
    case 'collections':
      return <>
        <Text label="Title" value={String(s.title)} onChange={(v) => set('title', v)} />
        <Chips label="Columns" value={String(s.columns)} options={[['2', '2'], ['3', '3'], ['4', '4']]} onChange={(v) => set('columns', Number(v))} />
      </>
    case 'products':
      return <>
        <Text label="Title" value={String(s.title)} onChange={(v) => set('title', v)} />
        <Range label="Products" value={Number(s.count)} min={2} max={8} step={2} onChange={(v) => set('count', v)} />
        <label className="flex items-center gap-2 text-[#8a8f98]"><input type="checkbox" checked={Boolean(s.prices)} onChange={(e) => set('prices', e.target.checked)} className="accent-[#2142e7]" /> Show prices</label>
      </>
    case 'richtext':
      return <>
        <Text label="Heading" value={String(s.heading)} onChange={(v) => set('heading', v)} />
        <Text label="Text" value={String(s.body)} onChange={(v) => set('body', v)} long />
      </>
    case 'footer':
      return <Text label="Text" value={String(s.text)} onChange={(v) => set('text', v)} />
  }
}

const field = 'mt-1 w-full rounded-md border border-white/10 bg-transparent px-2 py-1.5 text-[#f7f8f8] outline-none focus:border-[#2142e7]'

function Text({ label, value, onChange, long }: { label: string; value: string; onChange: (v: string) => void; long?: boolean }) {
  return (
    <label className="block text-[#8a8f98]">{label}
      {long ? <textarea value={value} rows={3} maxLength={160} onChange={(e) => onChange(e.target.value)} className={cn(field, 'resize-none')} />
        : <input value={value} maxLength={60} onChange={(e) => onChange(e.target.value)} className={field} />}
    </label>
  )
}

function Range({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="block text-[#8a8f98]">
      <span className="flex justify-between">{label}<span className="tabular-nums text-[#d0d6e0]">{value}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="mt-1.5 w-full accent-[#2142e7]" />
    </label>
  )
}

function Chips({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange: (v: string) => void }) {
  return (
    <div className="text-[#8a8f98]">{label}
      <div className="mt-1 flex flex-wrap gap-1" role="radiogroup" aria-label={label}>
        {options.map(([v, l]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
            className={cn('rounded-md border px-2 py-1', value === v ? 'border-[#2142e7] bg-[#2142e7]/15 text-white' : 'border-white/10 hover:text-[#d0d6e0]')}>{l}</button>
        ))}
      </div>
    </div>
  )
}
