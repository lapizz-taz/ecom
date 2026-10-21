import {
  BadgeCheck, BadgePercent, Box, Clock, CreditCard, Film, Gift, LayoutList, ListChecks, Megaphone, MousePointerClick, PackagePlus,
  PanelBottom, Rows3, Search, ShoppingCart, Sparkles, Star, Tag, Ticket, Truck, Users,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { BLOCK_TYPES, PRODUCT_BLOCKS, type ProductBlockType } from '@/features/storefront/product-blocks'
import { cn } from '@/lib/utils'

// The product page blocks as the editor and Store → Theme show them: an icon, a small drawing of
// the block, and a picker to add one. Fixed colours: the same look in the light and dark admin.

type BlockKind = Exclude<ProductBlockType, 'buttons'>

export const BLOCK_ICON: Record<ProductBlockType, ReactNode> = {
  buttons: <ShoppingCart className="size-4" />, bundles: <Gift className="size-4" />, tabs: <Rows3 className="size-4" />,
  atc_style: <MousePointerClick className="size-4" />, video: <Film className="size-4" />, addons: <PackagePlus className="size-4" />,
  sticky_atc: <PanelBottom className="size-4" />, shipping_info: <Truck className="size-4" />, benefits: <Sparkles className="size-4" />,
  benefits_list: <ListChecks className="size-4" />, upsell: <BadgePercent className="size-4" />, social_proof: <Users className="size-4" />,
  payment_icons: <CreditCard className="size-4" />, pulse_badge: <BadgeCheck className="size-4" />, badges: <Tag className="size-4" />,
  countdown: <Clock className="size-4" />, review_summary: <Star className="size-4" />, coupon: <Ticket className="size-4" />,
  wrapper: <Box className="size-4" />, banner: <Megaphone className="size-4" />, reviews: <LayoutList className="size-4" />, space: <Rows3 className="size-4" />,
}

const bar = 'rounded-sm bg-[#d4d4d8]'

/** A small drawing of the block, as in a block library. */
export function BlockThumb({ type }: { type: BlockKind }) {
  switch (type) {
    case 'bundles': return (
      <div className="grid w-full gap-1 px-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className={cn('flex items-center gap-1.5 rounded-sm border px-1.5 py-1', i === 1 ? 'border-[#18181b] bg-[#f4f4f5]' : 'border-[#e4e4e7]')}>
            <span className={cn('size-1.5 rounded-full border', i === 1 ? 'border-[#18181b] bg-[#18181b]' : 'border-[#a1a1aa]')} />
            <span className={cn(bar, 'h-1 w-10')} />{i > 0 && <span className="h-1.5 w-5 rounded-sm bg-[#bbf7d0]" />}<span className={cn(bar, 'ml-auto h-1 w-6 bg-[#a1a1aa]')} />
          </div>
        ))}
      </div>
    )
    case 'pulse_badge': return <div className="flex items-center gap-1.5"><span className="relative size-2 rounded-full bg-[#16a34a] shadow-[0_0_0_3px_rgb(22_163_74/.25)]" /><span className="h-1.5 w-20 rounded-sm bg-[#86efac]" /></div>
    case 'countdown': return <div className="flex gap-1">{['02', '14', '37', '09'].map((t) => <span key={t} className="rounded-sm bg-[#b91c1c] px-1 py-0.5 text-[8px] font-semibold text-white tabular-nums">{t}</span>)}</div>
    case 'coupon': return <div className="flex items-center gap-1.5 rounded-sm border border-dashed border-[#71717a] px-2 py-1"><span className="font-mono text-[8px] font-semibold">SAVE10</span><span className="rounded-sm bg-[#18181b] px-1.5 py-0.5 text-[7px] text-white">Copy</span></div>
    case 'review_summary': return <div className="flex items-center gap-1"><span className="text-[8px] font-semibold">Excellent</span>{[0, 1, 2, 3, 4].map((i) => <Star key={i} className="size-2.5 text-[#f59e0b]" fill="currentColor" strokeWidth={0} />)}</div>
    case 'badges': return <div className="flex gap-1"><span className="h-2.5 w-10 rounded-full bg-[#bae6fd]" /><span className="h-2.5 w-12 rounded-full bg-[#bbf7d0]" /><span className="h-2.5 w-8 rounded-full bg-[#fecdd3]" /></div>
    case 'shipping_info': return <div className="grid w-28 gap-1 rounded-sm border border-[#e4e4e7] p-1.5"><div className="flex items-center gap-1"><Truck className="size-2.5" /><span className={cn(bar, 'h-1 w-10 bg-[#a1a1aa]')} /></div><span className={cn(bar, 'h-1 w-full')} /></div>
    case 'benefits_list': return <div className="grid gap-1">{[0, 1, 2].map((i) => <div key={i} className="flex items-center gap-1"><span className="text-[8px] leading-none text-[#16a34a]">✓</span><span className={cn(bar, 'h-1 w-20')} /></div>)}</div>
    case 'benefits': return <div className="flex gap-3">{[0, 1].map((i) => <div key={i} className="flex items-center gap-1"><span className="size-3.5 rounded-full bg-[#e4e4e7]" /><span className="grid gap-0.5"><span className={cn(bar, 'h-1 w-8 bg-[#a1a1aa]')} /><span className={cn(bar, 'h-1 w-10')} /></span></div>)}</div>
    case 'payment_icons': return <div className="flex gap-1"><span className="h-3 w-6 rounded-sm border border-[#d4d4d8]" /><span className="h-3 w-6 rounded-sm bg-[#e2136e]" /><span className="h-3 w-6 rounded-sm bg-[#f6921e]" /><span className="h-3 w-6 rounded-sm bg-[#1a1f71]" /></div>
    case 'tabs': return <div className="w-28"><div className="flex gap-2 border-b border-[#e4e4e7] pb-1"><span className="h-1 w-6 rounded-sm bg-[#18181b]" /><span className={cn(bar, 'h-1 w-6')} /><span className={cn(bar, 'h-1 w-6')} /></div><div className={cn(bar, 'mt-1.5 h-1 w-full')} /><div className={cn(bar, 'mt-1 h-1 w-3/4')} /></div>
    case 'addons':
    case 'upsell': return <div className="grid w-28 gap-1">{[0, 1].map((i) => <div key={i} className="flex items-center gap-1 rounded-sm border border-[#e4e4e7] p-1"><span className="size-3 rounded-sm bg-[#e4e4e7]" /><span className={cn(bar, 'h-1 w-10')} /><span className="ml-auto h-2.5 w-5 rounded-sm bg-[#18181b]" /></div>)}</div>
    case 'social_proof': return <div className="flex items-center gap-1.5"><span className="flex -space-x-1">{[0, 1, 2].map((i) => <span key={i} className="size-3 rounded-full border border-white bg-[#a1a1aa]" />)}</span><span className={cn(bar, 'h-1 w-14')} /></div>
    case 'reviews': return <div className="flex gap-1">{[0, 1].map((i) => <div key={i} className="grid w-12 gap-0.5 rounded-sm border border-[#e4e4e7] p-1"><span className="h-1 w-6 rounded-sm bg-[#f59e0b]" /><span className={cn(bar, 'h-1')} /><span className={cn(bar, 'h-1 w-2/3')} /></div>)}</div>
    case 'video': return <div className="flex gap-1">{[0, 1, 2].map((i) => <span key={i} className="grid h-9 w-6 place-items-center rounded-sm bg-[#3f3f46]"><span className="size-0 border-y-[3px] border-l-[5px] border-y-transparent border-l-white/80" /></span>)}</div>
    case 'banner': return <div className="h-4 w-28 rounded-sm border border-[#fecaca] bg-[#fef2f2] px-1.5 py-1"><span className="block h-1 w-16 rounded-sm bg-[#f87171]" /></div>
    case 'space': return <div className="grid w-28 gap-2"><span className={cn(bar, 'h-1')} /><span className="h-px w-full bg-[#a1a1aa]" /><span className={cn(bar, 'h-1')} /></div>
    case 'atc_style': return <span className="rounded-sm bg-[#18181b] px-3 py-1 text-[7px] font-semibold tracking-wider text-white">ADD TO CART</span>
    case 'sticky_atc': return <div className="flex w-28 items-center gap-1 rounded-sm border border-[#e4e4e7] bg-white p-1 shadow-sm"><span className="size-3 rounded-sm bg-[#e4e4e7]" /><span className={cn(bar, 'h-1 w-8')} /><span className="ml-auto h-2.5 w-8 rounded-sm bg-[#18181b]" /></div>
    case 'wrapper': return <div className="grid h-9 w-24 content-center gap-1 rounded border-2 border-[#a1a1aa] px-2"><span className={cn(bar, 'h-1 w-2/3 bg-[#a1a1aa]')} /><span className={cn(bar, 'h-1')} /></div>
  }
}

/** Add a block: a searchable list. */
export function BlockPicker({ onPick, has }: { onPick: (type: BlockKind) => void; has: (type: BlockKind) => boolean }) {
  const [q, setQ] = useState('')
  const types = BLOCK_TYPES.filter((t) => `${PRODUCT_BLOCKS[t].label} ${PRODUCT_BLOCKS[t].description}`.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div className="w-[300px] overflow-hidden rounded-xl border border-[#e4e4e7] bg-white text-[13px] text-[#18181b] shadow-xl">
      <label className="flex items-center gap-2 border-b border-[#e4e4e7] px-3"><Search className="size-3.5 text-[#71717a]" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search blocks" className="h-10 flex-1 bg-transparent outline-none" />
      </label>
      <div className="max-h-[380px] overflow-y-auto p-1.5">
        {types.map((t) => (
          <button key={t} type="button" onClick={() => onPick(t)} disabled={has(t)}
            className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-[#f4f4f5] disabled:opacity-45 disabled:hover:bg-transparent">
            <span className="mt-0.5 text-[#71717a]">{BLOCK_ICON[t]}</span>
            <span className="min-w-0 flex-1"><span className="block font-medium">{PRODUCT_BLOCKS[t].label}{has(t) && <span className="ml-1.5 text-[11px] font-normal text-[#71717a]">added</span>}</span>
              <span className="block text-[11px] leading-snug text-[#71717a]">{PRODUCT_BLOCKS[t].description}</span></span>
          </button>
        ))}
        {!types.length && <p className="px-2 py-6 text-center text-xs text-[#71717a]">No blocks match “{q}”.</p>}
      </div>
    </div>
  )
}
