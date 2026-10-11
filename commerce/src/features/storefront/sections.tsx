import { useQuery } from '@tanstack/react-query'
import { BadgeCheck, RotateCcw, ShieldCheck, Truck } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'
import { imageUrl } from '@/services/catalog'
import { getCategories, listProducts } from '@/services/storefront'
import { ProductGrid } from './product-card'
import { isThemePreview, SECTIONS, selectInBuilder, usePreviewSelection, type Settings, type ThemeSection } from './theme'

const s = (v: unknown, d = '') => (typeof v === 'string' ? v : d)
const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || d)

/** Wraps a section so the theme builder can point at it and select it in the preview. */
export function SectionFrame({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const preview = isThemePreview()
  const { selected, hovered, inspect } = usePreviewSelection()
  if (!preview || !inspect) return <div data-section-id={id}>{children}</div>
  const active = selected === id
  return (
    <div data-section-id={id} className="group/section relative" onClickCapture={(e) => {
      if (!active) { e.preventDefault(); e.stopPropagation(); selectInBuilder(id) }
    }}>
      {children}
      <div className={cn('pointer-events-none absolute inset-0 z-30 ring-2 ring-inset transition-opacity',
        active ? 'opacity-100 ring-[#2c6ecb]' : hovered === id ? 'opacity-100 ring-[#2c6ecb]/60' : 'opacity-0 ring-[#2c6ecb]/60 group-hover/section:opacity-100')}>
        <span className={cn('absolute top-0 left-0 bg-[#2c6ecb] px-2 py-0.5 font-sans text-[11px] font-medium tracking-normal text-white normal-case', !active && 'bg-[#2c6ecb]/80')}>{label}</span>
      </div>
    </div>
  )
}

export function ThemeSections({ sections }: { sections: ThemeSection[] }) {
  return (
    <>
      {sections.filter((x) => x.enabled).map((x) => (
        <SectionFrame key={x.id} id={x.id} label={SECTIONS[x.type].label}>
          <Section section={x} />
        </SectionFrame>
      ))}
    </>
  )
}

function Section({ section }: { section: ThemeSection }) {
  const st = section.settings
  switch (section.type) {
    case 'hero': return <Hero st={st} />
    case 'collections': return <CollectionList st={st} />
    case 'featured':
    case 'new': return <ProductsSection st={st} />
    case 'trust': return <Trust st={st} />
    case 'banner': return <Banner st={st} />
    case 'rich_text': return <RichText st={st} />
    case 'marquee': return <Marquee st={st} />
    case 'image_text': return <ImageText st={st} />
    case 'video': return <VideoSection st={st} />
  }
}

function Placeholder({ className, label }: { className?: string; label: string }) {
  return (
    <div className={cn('grid size-full place-items-center bg-[repeating-linear-gradient(135deg,#e4e4e7_0_1px,transparent_1px_14px)] bg-zinc-100 text-xs tracking-widest text-zinc-500 uppercase', className)}>{label}</div>
  )
}

function CtaButton({ label, link, style = 'solid', inverted = false }: { label: string; link: string; style?: string; inverted?: boolean }) {
  if (!label) return null
  if (style === 'link') return <Link to={link || '/shop'} className="text-sm font-medium underline underline-offset-4">{label}</Link>
  return (
    <Link to={link || '/shop'} className={cn('inline-flex h-11 items-center justify-center rounded-[var(--radius)] px-8 text-xs font-medium tracking-[0.12em] uppercase transition-opacity hover:opacity-85',
      inverted ? 'bg-white text-black' : 'bg-primary text-primary-foreground')}>{label}</Link>
  )
}

const HEIGHT: Record<string, string> = { small: 'min-h-[40vh]', medium: 'min-h-[60vh]', large: 'min-h-[80vh]', full: 'min-h-[calc(100dvh-4rem)]' }

function Hero({ st }: { st: Settings }) {
  const image = s(st.image_url)
  const video = s(st.video_url)
  const pos = s(st.position, 'bottom-left')
  const heading = s(st.heading)
  const media = !!(image || video)
  return (
    <section className={cn('relative isolate flex overflow-hidden bg-zinc-900 text-white', HEIGHT[s(st.height, 'large')] ?? HEIGHT.large,
      pos === 'center' ? 'items-center justify-center text-center' : pos === 'bottom-center' ? 'items-end justify-center text-center' : 'items-end')}>
      {video
        ? <video src={video} poster={image || undefined} autoPlay muted loop playsInline className="absolute inset-0 -z-10 size-full object-cover" />
        : image ? <img src={imageUrl(image, 1920)} alt="" className="absolute inset-0 -z-10 size-full object-cover" />
          : <Placeholder className="absolute inset-0 -z-10 bg-zinc-800 text-zinc-400" label="Add a hero image" />}
      {media && <div className="absolute inset-0 -z-10 bg-black" style={{ opacity: n(st.overlay, 25) / 100 }} />}
      <div className={cn('flex w-full max-w-3xl flex-col gap-4 px-6 py-10 sm:px-10 sm:py-14', pos === 'bottom-left' ? 'items-start' : 'mx-auto items-center')}>
        {heading && <h1 className="text-3xl leading-tight font-semibold sm:text-5xl">{heading}</h1>}
        <div className={cn('flex flex-col gap-4 sm:flex-row sm:items-center', pos !== 'bottom-left' && 'items-center')}>
          <CtaButton label={s(st.button_label)} link={s(st.button_link, '/shop')} style={s(st.button_style)} inverted />
          {s(st.text) && <p className="max-w-md text-sm leading-relaxed text-white/90">{s(st.text)}</p>}
        </div>
      </div>
    </section>
  )
}

const ASPECT: Record<string, string> = { portrait: 'aspect-[4/5]', square: 'aspect-square', landscape: 'aspect-[4/3]' }
const TILE_COLS: Record<number, string> = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4' }

function CollectionList({ st }: { st: Settings }) {
  const categories = useQuery({ queryKey: ['storefront-categories'], queryFn: getCategories, staleTime: 10 * 60_000 })
  const chosen = Array.isArray(st.categories) ? (st.categories as string[]) : []
  const cols = Math.min(Math.max(n(st.columns, 3), 2), 4)
  const list = (categories.data ?? []).filter((c) => (chosen.length ? chosen.includes(c.slug) : !c.parent_id && c.product_count > 0))
    .sort((a, b) => (chosen.length ? chosen.indexOf(a.slug) - chosen.indexOf(b.slug) : 0)).slice(0, cols * 2)
  const overlay = s(st.labels) === 'overlay'
  return (
    <section>
      {s(st.heading) && <h2 className="px-4 pt-10 pb-4 text-xl font-medium sm:px-8">{s(st.heading)}</h2>}
      <div className={cn('grid grid-cols-1 gap-px', TILE_COLS[cols])}>
        {(list.length ? list : Array.from({ length: cols }, (_, i) => ({ id: `tile-${i}`, slug: '', name: 'Your category', image_url: null as string | null })))
          .map((c) => (
            <Link key={c.id} to={c.slug ? `/collection/${c.slug}` : '/shop'} className="group block">
              <div className={cn('relative overflow-hidden', ASPECT[s(st.aspect, 'portrait')] ?? ASPECT.portrait)}>
                {c.image_url ? <img src={imageUrl(c.image_url, 900)} alt="" loading="lazy" className="size-full object-cover transition-transform duration-700 group-hover:scale-[1.03]" />
                  : <Placeholder label={c.name} />}
                {overlay && <span className="absolute bottom-4 left-4 text-2xl font-medium text-white drop-shadow">{c.name}</span>}
              </div>
              {!overlay && <p className="px-2 pt-1.5 pb-3 text-[11px] tracking-wide uppercase">{c.name}</p>}
            </Link>
          ))}
      </div>
    </section>
  )
}

function ProductsSection({ st }: { st: Settings }) {
  const source = s(st.source, 'featured')
  const limit = Math.min(Math.max(n(st.limit, 8), 1), 24)
  const category = s(st.category)
  const q = useQuery({
    queryKey: ['products', 'section', source, category, limit],
    queryFn: () => listProducts(source === 'featured' ? { featured: true, limit, sort: 'featured' } : source === 'category' && category ? { category, limit, sort: 'newest' } : { limit, sort: 'newest' }),
  })
  const items = q.data?.items ?? []
  if (!q.isLoading && !items.length && !isThemePreview()) return null
  const viewAll = source === 'category' && category ? `/collection/${category}` : source === 'newest' ? '/shop?sort=newest' : '/shop'
  return (
    <section className="pt-10 pb-4">
      <div className="mx-auto flex max-w-[1600px] items-end justify-between px-4 pb-4 sm:px-8">
        {s(st.heading) && <h2 className="text-2xl font-medium italic sm:text-[28px]">{s(st.heading)}</h2>}
        {st.view_all !== false && <Link to={viewAll} className="text-xs tracking-wide uppercase underline-offset-4 hover:underline">View all</Link>}
      </div>
      <div className="mx-auto max-w-[1600px] sm:px-8">
        {!q.isLoading && !items.length
          ? <div className="px-4 py-10 text-center text-sm text-muted-foreground">No products match this section yet.</div>
          : <ProductGrid products={items} loading={q.isLoading} count={limit} columns={Math.min(Math.max(n(st.columns, 4), 2), 5)} />}
      </div>
    </section>
  )
}

const TRUST_ICONS = [Truck, RotateCcw, ShieldCheck, BadgeCheck]
function Trust({ st }: { st: Settings }) {
  const items = (Array.isArray(st.items) ? st.items : []) as Array<{ title: string; text: string }>
  return (
    <section className="mx-auto grid max-w-[1600px] grid-cols-1 gap-px border-y sm:grid-cols-2 lg:grid-cols-4">
      {items.map((f, i) => {
        const Icon = TRUST_ICONS[i % TRUST_ICONS.length]
        return (
          <div key={i} className="flex items-center gap-3 px-6 py-6 text-sm">
            <Icon className="size-5 shrink-0" strokeWidth={1.5} />
            <div><p className="text-xs font-medium tracking-wide uppercase">{f.title}</p><p className="text-muted-foreground">{f.text}</p></div>
          </div>
        )
      })}
    </section>
  )
}

function Banner({ st }: { st: Settings }) {
  if (!s(st.title) && !isThemePreview()) return null
  return (
    <section className="relative isolate overflow-hidden bg-primary px-6 py-20 text-primary-foreground sm:px-12">
      {s(st.image_url) && <img src={imageUrl(s(st.image_url), 1600)} alt="" className="absolute inset-0 -z-10 size-full object-cover opacity-40" />}
      <div className="mx-auto max-w-2xl space-y-4 text-center">
        <h2 className="text-3xl font-semibold sm:text-4xl">{s(st.title) || 'Add a banner heading'}</h2>
        {s(st.text) && <p className="opacity-80">{s(st.text)}</p>}
        <CtaButton label={s(st.label)} link={s(st.link, '/shop')} inverted />
      </div>
    </section>
  )
}

function RichText({ st }: { st: Settings }) {
  const center = s(st.align, 'center') === 'center'
  return (
    <section className={cn('mx-auto max-w-3xl space-y-4 px-6 py-16', center && 'text-center')}>
      {s(st.heading) && <h2 className="text-2xl font-medium sm:text-3xl">{s(st.heading)}</h2>}
      {s(st.text) && <p className="leading-relaxed whitespace-pre-line text-muted-foreground">{s(st.text)}</p>}
      <CtaButton label={s(st.button_label)} link={s(st.button_link, '/shop')} />
    </section>
  )
}

export function MarqueeStrip({ items, seconds = 30, className, style }: { items: string[]; seconds?: number; className?: string; style?: CSSProperties }) {
  const list = items.filter(Boolean)
  if (!list.length) return null
  const row = Array.from({ length: Math.max(4, Math.ceil(12 / list.length)) }, () => list).flat()
  return (
    <div className={cn('flex overflow-hidden whitespace-nowrap', className)} style={style}>
      {[0, 1].map((k) => (
        <div key={k} aria-hidden={k === 1} className="flex shrink-0 animate-[marquee_var(--marquee-s)_linear_infinite] motion-reduce:animate-none" style={{ '--marquee-s': `${seconds}s` } as CSSProperties}>
          {row.map((t, i) => <span key={i} className="px-10">{t}</span>)}
        </div>
      ))}
    </div>
  )
}

function Marquee({ st }: { st: Settings }) {
  const items = s(st.items).split(/[·|]/).map((x) => x.trim()).filter(Boolean)
  return <MarqueeStrip items={items} seconds={n(st.speed, 30)} className={cn('py-3 text-xs font-medium tracking-[0.2em] uppercase', st.inverted !== false ? 'bg-foreground text-background' : 'border-y')} />
}

function ImageText({ st }: { st: Settings }) {
  const right = s(st.image_side) === 'right'
  return (
    <section className="grid items-center md:grid-cols-2">
      <div className={cn('aspect-[4/5] md:aspect-auto md:h-full md:min-h-[520px]', right && 'md:order-2')}>
        {s(st.image_url) ? <img src={imageUrl(s(st.image_url), 1200)} alt="" loading="lazy" className="size-full object-cover" /> : <Placeholder label="Add an image" />}
      </div>
      <div className="space-y-4 px-6 py-12 sm:px-14">
        {s(st.heading) && <h2 className="text-2xl font-medium sm:text-3xl">{s(st.heading)}</h2>}
        {s(st.text) && <p className="leading-relaxed whitespace-pre-line text-muted-foreground">{s(st.text)}</p>}
        <CtaButton label={s(st.button_label)} link={s(st.button_link, '/shop')} />
      </div>
    </section>
  )
}

function youtubeId(url: string): string | null {
  const m = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/.exec(url)
  return m ? m[1] : null
}

function VideoSection({ st }: { st: Settings }) {
  const url = s(st.url)
  const yt = youtubeId(url)
  return (
    <section className="py-10">
      {s(st.heading) && <h2 className="px-4 pb-4 text-xl font-medium sm:px-8">{s(st.heading)}</h2>}
      <div className="aspect-video w-full bg-black">
        {yt ? <iframe className="size-full" src={`https://www.youtube-nocookie.com/embed/${yt}?rel=0`} title={s(st.heading, 'Video')} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
          : /^https:\/\/.+\.(mp4|webm)(\?.*)?$/i.test(url) ? <video src={url} className="size-full object-cover" controls={st.autoplay === false} autoPlay={st.autoplay !== false} muted={st.autoplay !== false} loop playsInline />
            : <Placeholder className="bg-zinc-900 text-zinc-400" label="Add a YouTube or MP4 link" />}
      </div>
    </section>
  )
}
