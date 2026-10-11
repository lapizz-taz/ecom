import { ChevronDown, Film, Image, LayoutGrid, Megaphone, PanelsTopLeft, Search, ShieldCheck, Type } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { SECTIONS, type SectionType } from '@/features/storefront/theme'
import { cn } from '@/lib/utils'

const GROUPS = ['Banners', 'Collections', 'Products', 'Text', 'Media', 'Trust'] as const

export const SECTION_ICON: Record<SectionType, ReactNode> = {
  hero: <PanelsTopLeft className="size-4" />, banner: <Megaphone className="size-4" />, collections: <LayoutGrid className="size-4" />,
  featured: <LayoutGrid className="size-4" />, new: <LayoutGrid className="size-4" />, rich_text: <Type className="size-4" />,
  marquee: <Type className="size-4" />, image_text: <Image className="size-4" />, video: <Film className="size-4" />, trust: <ShieldCheck className="size-4" />,
}

/** A small drawing of what the section looks like. */
function Thumb({ type }: { type: SectionType }) {
  const bar = 'rounded-sm bg-zinc-300'
  switch (type) {
    case 'hero': return <div className="flex h-full flex-col justify-end bg-zinc-700 p-3"><div className="h-2 w-1/3 rounded-sm bg-white/80" /><div className="mt-1.5 flex gap-1.5"><div className="h-3 w-10 bg-white" /><div className="h-1.5 w-1/3 self-center rounded-sm bg-white/50" /></div></div>
    case 'banner': return <div className="grid h-full place-items-center bg-zinc-800"><div className="grid justify-items-center gap-1.5"><div className="h-2 w-24 rounded-sm bg-white/80" /><div className="h-3 w-12 bg-white" /></div></div>
    case 'collections': return <div className="grid h-full grid-cols-3 gap-px p-2">{[0, 1, 2].map((i) => <div key={i} className="flex flex-col gap-1"><div className="flex-1 bg-zinc-300" /><div className={cn(bar, 'h-1 w-2/3')} /></div>)}</div>
    case 'featured':
    case 'new': return <div className="flex h-full flex-col gap-1.5 p-2"><div className={cn(bar, 'h-1.5 w-1/4')} /><div className="grid flex-1 grid-cols-4 gap-px">{[0, 1, 2, 3].map((i) => <div key={i} className="flex flex-col gap-1"><div className="flex-1 bg-zinc-200" /><div className={cn(bar, 'h-1 w-3/4')} /></div>)}</div></div>
    case 'rich_text': return <div className="grid h-full place-items-center"><div className="grid justify-items-center gap-1.5"><div className={cn(bar, 'h-2 w-20 bg-zinc-400')} /><div className={cn(bar, 'h-1 w-32')} /><div className={cn(bar, 'h-1 w-28')} /></div></div>
    case 'marquee': return <div className="grid h-full items-center"><div className="flex h-5 items-center gap-3 overflow-hidden bg-zinc-900 px-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-1 w-12 shrink-0 rounded-sm bg-white/70" />)}</div></div>
    case 'image_text': return <div className="grid h-full grid-cols-2"><div className="bg-zinc-300" /><div className="grid content-center gap-1.5 p-3"><div className={cn(bar, 'h-2 w-2/3 bg-zinc-400')} /><div className={cn(bar, 'h-1 w-full')} /><div className={cn(bar, 'h-1 w-4/5')} /></div></div>
    case 'video': return <div className="grid h-full place-items-center bg-zinc-900"><div className="size-0 border-y-[8px] border-l-[13px] border-y-transparent border-l-white/80" /></div>
    case 'trust': return <div className="grid h-full grid-cols-3 items-center gap-2 p-3">{[0, 1, 2].map((i) => <div key={i} className="flex items-center gap-1"><div className="size-3 rounded-full bg-zinc-400" /><div className={cn(bar, 'h-1 flex-1')} /></div>)}</div>
  }
}

export function SectionPicker({ onPick }: { onPick: (type: SectionType) => void }) {
  const [q, setQ] = useState('')
  const [hover, setHover] = useState<SectionType>('hero')
  const [closed, setClosed] = useState<string[]>([])
  const types = useMemo(() => (Object.keys(SECTIONS) as SectionType[]).filter((t) => t !== 'new' && SECTIONS[t].label.toLowerCase().includes(q.trim().toLowerCase())), [q])
  return (
    <div className="flex h-[min(30rem,70vh)] w-[min(42rem,90vw)] overflow-hidden rounded-xl bg-white text-[13px] shadow-xl ring-1 ring-black/10 dark:bg-zinc-900">
      <div className="flex w-60 shrink-0 flex-col border-r dark:border-zinc-800">
        <div className="p-2">
          <label className="flex h-8 items-center gap-2 rounded-lg border border-zinc-300 px-2 focus-within:border-zinc-900 focus-within:ring-2 focus-within:ring-[#2c6ecb]/30 dark:border-zinc-700">
            <Search className="size-3.5 text-zinc-500" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sections" className="w-full bg-transparent outline-none" />
          </label>
        </div>
        <div className="mx-2 mb-1 grid grid-cols-2 rounded-lg bg-zinc-100 p-0.5 text-xs dark:bg-zinc-800">
          <span className="rounded-md bg-white py-1 text-center font-medium shadow-xs dark:bg-zinc-700">Sections</span>
          <span className="py-1 text-center text-zinc-500" title="Apps you install appear here">Apps</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {GROUPS.map((g) => {
            const list = types.filter((t) => SECTIONS[t].group === g)
            if (!list.length) return null
            const open = !closed.includes(g)
            return (
              <div key={g}>
                <button type="button" className="flex w-full items-center justify-between px-2 pt-2.5 pb-1 text-xs font-semibold" onClick={() => setClosed(open ? [...closed, g] : closed.filter((x) => x !== g))}>
                  {g === 'Products' ? 'Products' : g} <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} />
                </button>
                {open && list.map((t) => (
                  <button key={t} type="button" onMouseEnter={() => setHover(t)} onFocus={() => setHover(t)} onClick={() => onPick(t)}
                    className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left', hover === t ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50')}>
                    <span className="text-zinc-500">{SECTION_ICON[t]}</span>{SECTIONS[t].label}
                  </button>
                ))}
              </div>
            )
          })}
          {!types.length && <p className="px-2 py-6 text-center text-xs text-zinc-500">No sections match “{q}”.</p>}
        </div>
      </div>
      <div className="hidden min-w-0 flex-1 flex-col gap-3 bg-zinc-50 p-5 sm:flex dark:bg-zinc-950">
        <div className="aspect-[16/10] overflow-hidden rounded-lg border bg-white shadow-xs dark:border-zinc-800"><Thumb type={hover} /></div>
        <div>
          <p className="font-medium">{SECTIONS[hover].label}</p>
          <p className="mt-0.5 text-xs text-zinc-500">{SECTIONS[hover].description}</p>
        </div>
      </div>
    </div>
  )
}
