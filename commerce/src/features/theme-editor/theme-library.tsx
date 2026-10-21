import { Check } from 'lucide-react'
import { Link } from 'react-router'
import { FONTS, RADII, useThemeFont } from '@/features/storefront/theme'
import { THEME_PRESETS, type ThemePreset } from '@/features/storefront/theme-presets'
import { cn } from '@/lib/utils'

// Store → Theme: the ready-made themes. "Try it" opens the editor with the look on the draft
// (nothing is live until Publish, and Undo goes back).

/** A small drawing of a store in the preset's colours, fonts and corners. */
function PresetThumb({ preset }: { preset: ThemePreset }) {
  const { look } = preset
  const radius = RADII[look.radius].value
  const card = look.product_card.aspect === 'square' ? 'aspect-square' : 'aspect-[4/5]'
  return (
    <div aria-hidden className="flex size-full flex-col overflow-hidden text-left" style={{ background: look.colors.background, color: look.colors.text, fontFamily: FONTS[look.font].family }}>
      <div className="py-[3px] text-center text-[7px] tracking-wide" style={{ background: look.colors.announcement_bg, color: look.colors.announcement_text }}>Cash on delivery all over Bangladesh</div>
      <div className={cn('flex items-center px-3 py-1.5', look.logo_position === 'center' ? 'justify-center' : 'justify-between')}>
        <span className="text-[11px] font-semibold" style={{ fontFamily: FONTS[look.heading_font].family }}>Your store</span>
        {look.logo_position === 'left' && <span className="flex gap-1.5">{[0, 1, 2].map((i) => <span key={i} className="h-1 w-5 rounded-sm opacity-40" style={{ background: look.colors.text }} />)}</span>}
      </div>
      <div className="mx-3 grid h-[34%] place-items-center bg-[#3f3f46] px-3" style={{ borderRadius: look.radius === 'sharp' ? 0 : 6 }}>
        <div className="grid justify-items-center gap-1">
          <span className="text-[13px] leading-none font-semibold text-white" style={{ fontFamily: FONTS[look.heading_font].family, fontWeight: look.heading_weight === 'default' ? undefined : Number(look.heading_weight) }}>New collection</span>
          <span className="px-2 py-[3px] text-[6px] font-medium tracking-wider uppercase" style={{ background: '#fff', color: '#0b0b0c', borderRadius: radius }}>Shop now</span>
        </div>
      </div>
      <div className={cn('mx-3 mt-2 grid grid-cols-4', look.product_card.gap === 'large' ? 'gap-1.5' : 'gap-0.5')}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="grid gap-0.5">
            <div className={card} style={{ background: look.product_card.image_bg, borderRadius: look.radius === 'round' ? 6 : look.radius === 'soft' ? 3 : 0 }} />
            <span className={cn('truncate text-[6px]', look.product_card.uppercase && 'uppercase')}>Product {i + 1}</span>
            <span className="text-[6px] font-semibold" style={{ color: look.accent }}>৳1,250</span>
          </div>
        ))}
      </div>
      <div className="mt-auto h-3" style={{ background: look.colors.footer_bg }} />
    </div>
  )
}

export function ThemeLibrary({ current, canEdit }: { current: string; canEdit: boolean }) {
  useThemeFont(...THEME_PRESETS.flatMap((p) => [p.look.font, p.look.heading_font]))
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">Ready-made themes</h2>
        <p className="text-[13px] text-muted-foreground">Pick a look in one click. Your products, menu, texts, images and product page blocks stay. You see it in the editor first; nothing changes on your store until you publish.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-4">
        {THEME_PRESETS.map((p) => {
          const active = p.id === current
          return (
            <article key={p.id} className={cn('flex flex-col overflow-hidden rounded-xl border bg-card', active && 'ring-1 ring-foreground/70')}>
              <div className="aspect-[4/3] border-b"><PresetThumb preset={p} /></div>
              <div className="flex flex-1 flex-col gap-1.5 p-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[13px] font-semibold">{p.name}</h3>
                  <span className="flex gap-1">
                    {[p.look.colors.background, p.look.accent, p.look.colors.footer_bg].map((c) => <span key={c} className="size-3 rounded-full ring-1 ring-black/15" style={{ background: c }} />)}
                  </span>
                </div>
                <p className="text-xs font-medium">{p.for}</p>
                <p className="flex-1 text-xs leading-snug text-muted-foreground">{p.description}</p>
                <p className="text-[11px] text-muted-foreground">{p.look.heading_font === p.look.font ? FONTS[p.look.font].label : `${FONTS[p.look.heading_font].label} + ${FONTS[p.look.font].label}`}</p>
                {active
                  ? <span className="mt-1 inline-flex h-8 items-center justify-center gap-1 rounded-lg bg-muted text-xs font-medium"><Check className="size-3.5" /> Current</span>
                  : canEdit
                    ? <Link to={`/admin/store/theme/editor?preset=${p.id}`} className="mt-1 inline-flex h-8 items-center justify-center rounded-lg border text-xs font-semibold transition-colors hover:bg-muted">Try it</Link>
                    : null}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
