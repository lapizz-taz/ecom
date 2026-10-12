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

/** A small drawing of what the section looks like. Fixed colours: the editor looks the same in light and dark admin. */
function Thumb({ type }: { type: SectionType }) {
  const bar = 'rounded-sm bg-[#d4d4d8]'
  switch (type) {
    case 'hero': return <div className="flex h-full flex-col justify-end bg-[#3f3f46] p-3"><div className="h-2 w-1/3 rounded-sm bg-white/80" /><div className="mt-1.5 flex gap-1.5"><div className="h-3 w-10 bg-white" /><div className="h-1.5 w-1/3 self-center rounded-sm bg-white/50" /></div></div>
    case 'banner': return <div className="grid h-full place-items-center bg-[#27272a]"><div className="grid justify-items-center gap-1.5"><div className="h-2 w-24 rounded-sm bg-white/80" /><div className="h-3 w-12 bg-white" /></div></div>
    case 'collections': return <div className="grid h-full grid-cols-3 gap-px p-2">{[0, 1, 2].map((i) => <div key={i} className="flex flex-col gap-1"><div className="flex-1 bg-[#d4d4d8]" /><div className={cn(bar, 'h-1 w-2/3')} /></div>)}</div>
    case 'featured':
    case 'new': return <div className="flex h-full flex-col gap-1.5 p-2"><div className={cn(bar, 'h-1.5 w-1/4')} /><div className="grid flex-1 grid-cols-4 gap-px">{[0, 1, 2, 3].map((i) => <div key={i} className="flex flex-col gap-1"><div className="flex-1 bg-[#e4e4e7]" /><div className={cn(bar, 'h-1 w-3/4')} /></div>)}</div></div>
    case 'rich_text': return <div className="grid h-full place-items-center"><div className="grid justify-items-center gap-1.5"><div className={cn(bar, 'h-2 w-20 bg-[#a1a1aa]')} /><div className={cn(bar, 'h-1 w-32')} /><div className={cn(bar, 'h-1 w-28')} /></div></div>
    case 'marquee': return <div className="grid h-full items-center"><div className="flex h-5 items-center gap-3 overflow-hidden bg-[#18181b] px-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-1 w-12 shrink-0 rounded-sm bg-white/70" />)}</div></div>
    case 'image_text': return <div className="grid h-full grid-cols-2"><div className="bg-[#d4d4d8]" /><div className="grid content-center gap-1.5 p-3"><div className={cn(bar, 'h-2 w-2/3 bg-[#a1a1aa]')} /><div className={cn(bar, 'h-1 w-full')} /><div className={cn(bar, 'h-1 w-4/5')} /></div></div>
    case 'video': return <div className="grid h-full place-items-center bg-[#18181b]"><div className="size-0 border-y-[8px] border-l-[13px] border-y-transparent border-l-white/80" /></div>
    case 'trust': return <div className="grid h-full grid-cols-3 items-center gap-2 p-3">{[0, 1, 2].map((i) => <div key={i} className="flex items-center gap-1"><div className="size-3 rounded-full bg-[#a1a1aa]" /><div className={cn(bar, 'h-1 flex-1')} /></div>)}</div>
  }
}

/** Add a section: list on the left, a drawing of the hovered one on the right. */
export function SectionPicker({ onPick }: { onPick: (type: SectionType) => void }) {
  const [q, setQ] = useState('')
  const [hover, setHover] = useState<SectionType>('hero')
  const [closed, setClosed] = useState<string[]>([])
  const types = useMemo(() => (Object.keys(SECTIONS) as SectionType[]).filter((t) => t !== 'new' && SECTIONS[t].label.toLowerCase().includes(q.trim().toLowerCase())), [q])
  return (
    <div className="flex h-[min(30rem,70vh)] w-[min(42rem,90vw)] overflow-hidden rounded-xl bg-white text-[13px] text-[#1a1a1a] shadow-xl ring-1 ring-black/10">
      <div className="flex w-60 shrink-0 flex-col border-r border-[#e3e3e3]">
        <div className="p-2">
          <label className="flex h-8 items-center gap-2 rounded-lg border border-[#d4d4d8] bg-white px-2 focus-within:border-[#1a1a1a] focus-within:ring-2 focus-within:ring-[#2c6ecb]/30">
            <Search className="size-3.5 text-[#71717a]" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sections" className="w-full bg-transparent text-[#1a1a1a] outline-none placeholder:text-[#a1a1aa]" />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {GROUPS.map((g) => {
            const list = types.filter((t) => SECTIONS[t].group === g)
            if (!list.length) return null
            const open = !closed.includes(g)
            return (
              <div key={g}>
                <button type="button" className="flex w-full items-center justify-between px-2 pt-2.5 pb-1 text-xs font-semibold text-[#1a1a1a]" onClick={() => setClosed(open ? [...closed, g] : closed.filter((x) => x !== g))}>
                  {g} <ChevronDown className={cn('size-3.5 text-[#71717a] transition-transform', !open && '-rotate-90')} />
                </button>
                {open && list.map((t) => (
                  <button key={t} type="button" onMouseEnter={() => setHover(t)} onFocus={() => setHover(t)} onClick={() => onPick(t)}
                    className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[#1a1a1a] outline-none', hover === t ? 'bg-[#ebebeb]' : 'hover:bg-[#f4f4f4]')}>
                    <span className="text-[#71717a]">{SECTION_ICON[t]}</span>{SECTIONS[t].label}
                  </button>
                ))}
              </div>
            )
          })}
          {!types.length && <p className="px-2 py-6 text-center text-xs text-[#71717a]">No sections match “{q}”.</p>}
        </div>
      </div>
      <div className="hidden min-w-0 flex-1 flex-col gap-3 bg-[#f7f7f7] p-5 sm:flex">
        <div className="aspect-[16/10] overflow-hidden rounded-lg border border-[#e3e3e3] bg-white shadow-xs"><Thumb type={hover} /></div>
        <div>
          <p className="font-medium text-[#1a1a1a]">{SECTIONS[hover].label}</p>
          <p className="mt-0.5 text-xs text-[#71717a]">{SECTIONS[hover].description}</p>
        </div>
      </div>
    </div>
  )
}
