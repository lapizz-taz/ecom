import { ArrowDown, ArrowUp, ExternalLink, Laptop, Smartphone } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Field } from '@/components/common/field'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useSettingDraft } from '@/features/settings/setting-form'
import { ACCENTS, FONTS, RADII, resolveTheme, SECTION_LABELS, type SectionType, type StoreTheme, type Storefront } from '@/features/storefront/theme'
import { cn } from '@/lib/utils'

/** Theme builder for the store we host: look, header, home-page sections, footer — previewed live. */
export default function StoreThemePage() {
  const s = useSettingDraft('storefront')
  const frame = useRef<HTMLIFrameElement>(null)
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const [open, setOpen] = useState<SectionType | null>('hero')
  const draft = s.draft as Storefront | undefined
  const theme = resolveTheme(draft)

  // Send every change to the preview (and again when it says it is ready).
  useEffect(() => {
    const post = () => frame.current?.contentWindow?.postMessage({ type: 'theme-preview', storefront: draft }, window.location.origin)
    post()
    const onMessage = (e: MessageEvent) => { if (e.origin === window.location.origin && e.data?.type === 'theme-preview-ready') post() }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [draft])

  if (!draft) return <div className="grid place-items-center py-24"><Spinner /></div>
  const setTheme = (patch: Partial<StoreTheme>) => s.set(['theme'], { ...theme, ...patch })
  const text = (path: string) => ({ value: String(s.get([path]) ?? ''), onChange: (e: { target: { value: string } }) => s.set([path], e.target.value) })
  const move = (i: number, by: number) => {
    const next = [...theme.sections]
    const [item] = next.splice(i, 1)
    next.splice(i + by, 0, item)
    setTheme({ sections: next })
  }

  return (
    <div className="-m-3 flex flex-col sm:-mx-5 sm:-my-5 lg:h-[calc(100dvh-3.5rem)]">
      <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2.5">
        <div className="mr-auto">
          <h1 className="text-base font-semibold">Theme</h1>
          <p className="text-xs text-muted-foreground">Your store's look. Changes show on the right; customers see them after you publish.</p>
        </div>
        <div className="flex rounded-lg border p-0.5" role="group" aria-label="Preview size">
          {(['desktop', 'mobile'] as const).map((d) => (
            <button key={d} type="button" onClick={() => setDevice(d)} aria-pressed={device === d} aria-label={d}
              className={cn('grid size-7 place-items-center rounded-md', device === d ? 'bg-foreground text-background' : 'text-muted-foreground')}>
              {d === 'desktop' ? <Laptop className="size-4" /> : <Smartphone className="size-4" />}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" asChild><a href="/" target="_blank" rel="noreferrer"><ExternalLink /> View store</a></Button>
        <Button size="sm" variant="outline" onClick={s.reset} disabled={!s.dirty}>Discard</Button>
        <Button size="sm" onClick={() => s.save.mutate()} disabled={!s.dirty || !s.canEdit || s.save.isPending}>{s.save.isPending && <Spinner />} Publish</Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="min-h-0 shrink-0 overflow-y-auto border-b p-4 lg:w-[22rem] lg:border-r lg:border-b-0">
          <fieldset disabled={!s.canEdit} className="space-y-6">
            <Group title="Colour">
              <div className="flex flex-wrap gap-2">
                {ACCENTS.map((c) => (
                  <button key={c} type="button" onClick={() => setTheme({ accent: c })} aria-label={`Colour ${c}`} aria-pressed={theme.accent === c}
                    className={cn('size-8 rounded-full border-2 transition-transform hover:scale-110', theme.accent === c ? 'border-foreground' : 'border-transparent')}
                    style={{ background: c }} />
                ))}
                <label className="flex items-center gap-1.5 rounded-full border px-2 text-xs">
                  <input type="color" value={theme.accent} onChange={(e) => setTheme({ accent: e.target.value })} className="size-5 cursor-pointer bg-transparent" aria-label="Custom colour" />
                  {theme.accent}
                </label>
              </div>
            </Group>

            <Group title="Font">
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(FONTS).map(([k, f]) => (
                  <Choice key={k} active={theme.font === k} onClick={() => setTheme({ font: k as StoreTheme['font'] })}>
                    <span className="text-xl" style={{ fontFamily: f.family }}>{f.sample}</span>
                    <span className="text-[11px] text-muted-foreground">{f.label}</span>
                  </Choice>
                ))}
              </div>
            </Group>

            <Group title="Corners">
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(RADII).map(([k, r]) => (
                  <Choice key={k} active={theme.radius === k} onClick={() => setTheme({ radius: k as StoreTheme['radius'] })}>
                    <span className="size-6 border-2 border-foreground" style={{ borderRadius: r.value }} />
                    <span className="text-[11px] text-muted-foreground">{r.label}</span>
                  </Choice>
                ))}
              </div>
            </Group>

            <Group title="Header">
              <div className="grid grid-cols-2 gap-2">
                {(['left', 'center'] as const).map((p) => (
                  <Choice key={p} active={theme.logo_position === p} onClick={() => setTheme({ logo_position: p })}>
                    <span className={cn('flex h-4 w-16 items-center rounded bg-muted px-1', p === 'center' && 'justify-center')}><span className="h-1.5 w-5 rounded bg-foreground" /></span>
                    <span className="text-[11px] text-muted-foreground">Logo {p}</span>
                  </Choice>
                ))}
              </div>
              <Field label="Announcement bar" hint="Leave empty to hide"><Input {...text('announcement')} placeholder="Free delivery inside Dhaka" /></Field>
            </Group>

            <Group title="Home page">
              <ul className="divide-y rounded-lg border">
                {theme.sections.map((sec, i) => (
                  <li key={sec.type}>
                    <div className="flex items-center gap-2 px-2.5 py-2">
                      <button type="button" className="min-w-0 flex-1 truncate text-left text-sm" onClick={() => setOpen(open === sec.type ? null : sec.type)}>
                        {SECTION_LABELS[sec.type]}
                      </button>
                      <Button size="icon-sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${SECTION_LABELS[sec.type]} up`}><ArrowUp /></Button>
                      <Button size="icon-sm" variant="ghost" disabled={i === theme.sections.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${SECTION_LABELS[sec.type]} down`}><ArrowDown /></Button>
                      <Switch checked={sec.enabled} aria-label={`Show ${SECTION_LABELS[sec.type]}`}
                        onCheckedChange={(v) => setTheme({ sections: theme.sections.map((x) => (x.type === sec.type ? { ...x, enabled: v } : x)) })} />
                    </div>
                    {open === sec.type && (
                      <div className="space-y-3 border-t bg-muted/30 p-3">
                        {sec.type === 'hero' && <>
                          <Field label="Title"><Input {...text('hero_title')} /></Field>
                          <Field label="Subtitle"><Textarea rows={2} {...text('hero_subtitle')} /></Field>
                          <Field label="Image URL"><Input {...text('hero_image_url')} placeholder="https://…" /></Field>
                          <div className="grid grid-cols-2 gap-2">
                            <Field label="Button"><Input {...text('hero_cta_label')} /></Field>
                            <Field label="Link"><Input {...text('hero_cta_link')} /></Field>
                          </div>
                        </>}
                        {sec.type === 'trust' && theme.trust.map((t, k) => (
                          <div key={k} className="grid grid-cols-2 gap-2">
                            <Input aria-label={`Badge ${k + 1} title`} value={t.title} onChange={(e) => setTheme({ trust: theme.trust.map((x, j) => (j === k ? { ...x, title: e.target.value } : x)) })} />
                            <Input aria-label={`Badge ${k + 1} text`} value={t.text} onChange={(e) => setTheme({ trust: theme.trust.map((x, j) => (j === k ? { ...x, text: e.target.value } : x)) })} />
                          </div>
                        ))}
                        {sec.type === 'banner' && <>
                          <Field label="Title" hint="The banner shows once it has a title"><Input value={theme.banner.title} onChange={(e) => setTheme({ banner: { ...theme.banner, title: e.target.value } })} placeholder="Eid collection is here" /></Field>
                          <Field label="Text"><Input value={theme.banner.text} onChange={(e) => setTheme({ banner: { ...theme.banner, text: e.target.value } })} /></Field>
                          <Field label="Image URL"><Input value={theme.banner.image_url} onChange={(e) => setTheme({ banner: { ...theme.banner, image_url: e.target.value } })} placeholder="https://…" /></Field>
                          <div className="grid grid-cols-2 gap-2">
                            <Field label="Button"><Input value={theme.banner.label} onChange={(e) => setTheme({ banner: { ...theme.banner, label: e.target.value } })} /></Field>
                            <Field label="Link"><Input value={theme.banner.link} onChange={(e) => setTheme({ banner: { ...theme.banner, link: e.target.value } })} /></Field>
                          </div>
                        </>}
                        {(sec.type === 'categories' || sec.type === 'featured' || sec.type === 'new') && (
                          <p className="text-xs text-muted-foreground">
                            {sec.type === 'categories' ? 'Shows up to three categories with products.' : sec.type === 'featured' ? 'Products marked Featured.' : 'Your newest products.'}{' '}
                            <Link to="/admin/products" className="underline">Manage products</Link>
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Group>

            <Group title="Footer">
              <Field label="Footer text"><Input {...text('footer_text')} placeholder={`© ${new Date().getFullYear()} Your store`} /></Field>
              <label className="flex items-center justify-between gap-2 text-sm">Payment methods in the footer
                <Switch checked={theme.payment_badges} onCheckedChange={(v) => setTheme({ payment_badges: v })} />
              </label>
              <Field label="WhatsApp chat button" hint="A number shows a chat button on every page">
                <Input inputMode="tel" value={theme.whatsapp} onChange={(e) => setTheme({ whatsapp: e.target.value })} placeholder="01XXXXXXXXX" />
              </Field>
            </Group>
          </fieldset>
        </aside>

        <div className="grid min-h-[32rem] flex-1 place-items-center overflow-auto bg-muted/40 p-4">
          <iframe ref={frame} title="Store preview" src="/?theme_preview=1"
            className={cn('h-full min-h-[32rem] rounded-xl border bg-background shadow-sm transition-[width] duration-300', device === 'mobile' ? 'w-[390px]' : 'w-full')}
            onLoad={() => frame.current?.contentWindow?.postMessage({ type: 'theme-preview', storefront: draft }, window.location.origin)} />
        </div>
      </div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
      {children}
    </section>
  )
}

function Choice({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn('flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5 transition-colors', active ? 'border-foreground bg-muted' : 'hover:bg-muted/50')}>
      {children}
    </button>
  )
}
