import { useQuery } from '@tanstack/react-query'
import { Check, Loader2, Store, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Field } from '@/components/common/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatMoney, formatNumber } from '@/lib/format'
import { normalizePhone } from '@/lib/phone'
import { cn } from '@/lib/utils'
import { useDebounce } from '@/hooks/use-debounce'
import { BUSINESS_TYPES, checkStoreSlug, ORDER_VOLUMES, SELLS_ON, type SignupBusiness, type SignupOptions, type SignupPlan, suggestStoreSlug } from '@/services/onboarding'

const BD_MOBILE = /^01[3-9][0-9]{8}$/

/** The same checks the database makes, so mistakes show while typing. */
export function businessErrors(b: SignupBusiness): Partial<Record<keyof SignupBusiness, string>> {
  const e: Partial<Record<keyof SignupBusiness, string>> = {}
  const name = b.business_name.trim()
  if (name.length < 2 || name.length > 120) e.business_name = 'Enter your business name (2 to 120 characters)'
  if (b.full_name.trim().length < 2) e.full_name = 'Enter your name'
  if (!BD_MOBILE.test(normalizePhone(b.phone))) e.phone = 'Enter a Bangladesh mobile number (01XXXXXXXXX)'
  if (b.website.trim() && !/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(b.website.trim())) e.website = 'This address does not look right'
  if (b.online_store && b.store_slug && !/^[a-z0-9]([a-z0-9]|-(?!-)){1,40}$/.test(b.store_slug)) e.store_slug = 'Use lower-case letters, numbers and single dashes'
  return e
}

const LIMIT_LABELS: Array<[string, string]> = [['orders_per_month', 'orders a month'], ['products', 'products'], ['staff', 'team members'], ['stores', 'connected stores']]

function planLimits(p: SignupPlan) {
  return LIMIT_LABELS.map(([key, label]) => {
    const v = p.limits?.[key]
    return v == null ? `Unlimited ${label}` : `${formatNumber(v)} ${label}`
  })
}

const INTERVAL: Record<string, string> = { MONTHLY: 'month', MONTH: 'month', QUARTERLY: '3 months', YEARLY: 'year', YEAR: 'year', ANNUAL: 'year' }

/** Plan cards: price, trial, limits and what is included. */
export function PlanPicker({ options, value, onChange }: { options: SignupOptions; value: string; onChange: (code: string) => void }) {
  const popular = options.plans.length > 2 ? options.plans[1]?.code : null
  return (
    <div className="grid gap-3" role="radiogroup" aria-label="Plan">
      {options.plans.map((p) => {
        const selected = value === p.code
        return (
          <button key={p.code} type="button" role="radio" aria-checked={selected} onClick={() => onChange(p.code)}
            className={cn('group relative rounded-2xl border bg-card p-4 text-left shadow-xs transition-[border-color,box-shadow] hover:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none',
              selected && 'border-brand shadow-sm ring-1 ring-brand hover:border-brand')}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-semibold tracking-[-0.01em]">
                  {p.name}
                  {p.code === popular && <span className="rounded-full bg-brand-soft px-2 py-px text-[11px] font-medium text-brand">Most popular</span>}
                </p>
                {p.description && <p className="mt-0.5 text-[13px] text-muted-foreground">{p.description}</p>}
              </div>
              <div className="shrink-0 text-right">
                <p className="text-lg leading-none font-semibold tracking-[-0.02em] tabular-nums">{Number(p.price) === 0 ? 'Free' : formatMoney(p.price)}</p>
                {Number(p.price) > 0 && <p className="mt-1 text-[11px] text-muted-foreground">per {INTERVAL[p.billing_interval?.toUpperCase()] ?? 'month'}</p>}
              </div>
            </div>
            {p.trial_days > 0 && <p className="mt-3 inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">{p.trial_days}-day free trial · no payment now</p>}
            <ul className="mt-3 grid gap-x-4 gap-y-1.5 text-[13px] text-muted-foreground sm:grid-cols-2">
              {[...planLimits(p), ...p.features.slice(0, 6)].map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-muted', selected && 'bg-brand-soft text-brand')}><Check className="size-2.5" strokeWidth={3} /></span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <span aria-hidden className={cn('absolute top-4 right-4 hidden size-4 rounded-full border-2 border-foreground/20', selected && 'border-[5px] border-brand')} />
          </button>
        )
      })}
      {options.order_fee && (
        <p className="text-xs text-muted-foreground">
          Plus {formatMoney(options.order_fee.fee)} for each order you approve{options.order_fee.free_per_month > 0 ? ` after the first ${formatNumber(options.order_fee.free_per_month)} each month` : ''}, paid from your store balance.
        </p>
      )}
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className={cn('rounded-full border bg-card px-3 py-1.5 text-[13px] transition-colors hover:border-foreground/25',
        active && 'border-foreground bg-foreground text-background hover:border-foreground')}>
      {children}
    </button>
  )
}

/** Business details: name, owner, mobile, type, where they sell and how many orders. */
export function BusinessFields({ value, onChange, errors, showErrors }: {
  value: SignupBusiness
  onChange: (next: SignupBusiness) => void
  errors: Partial<Record<keyof SignupBusiness, string>>
  showErrors: boolean
}) {
  const set = <K extends keyof SignupBusiness>(k: K, v: SignupBusiness[K]) => onChange({ ...value, [k]: v })
  const err = (k: keyof SignupBusiness) => (showErrors ? errors[k] : undefined)
  return (
    <div className="grid gap-4">
      <Field label="Business name" required error={err('business_name')}>
        <Input value={value.business_name} onChange={(e) => set('business_name', e.target.value)} placeholder="e.g. Nadia Crafts" autoComplete="organization" maxLength={120} className="h-10" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Your name" required error={err('full_name')}>
          <Input value={value.full_name} onChange={(e) => set('full_name', e.target.value)} autoComplete="name" className="h-10" />
        </Field>
        <Field label="Mobile number" required error={err('phone')}>
          <Input value={value.phone} onChange={(e) => set('phone', e.target.value)} type="tel" inputMode="tel" autoComplete="tel" placeholder="01XXXXXXXXX" className="h-10" />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What do you sell?">
          <Select value={value.business_type || undefined} onValueChange={(v) => set('business_type', v)}>
            <SelectTrigger className="h-10"><SelectValue placeholder="Choose one" /></SelectTrigger>
            <SelectContent>{BUSINESS_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Website" hint="Optional" error={err('website')}>
          <Input value={value.website} onChange={(e) => set('website', e.target.value)} placeholder="yourshop.com" inputMode="url" autoComplete="url" className="h-10" />
        </Field>
      </div>
      <StoreChoice value={value} onChange={onChange} error={err('store_slug')} />
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Where do you sell now?</legend>
        <div className="flex flex-wrap gap-2">
          {SELLS_ON.map((o) => {
            const on = value.sells_on.includes(o.value)
            return <Chip key={o.value} active={on} onClick={() => set('sells_on', on ? value.sells_on.filter((x) => x !== o.value) : [...value.sells_on, o.value])}>{o.label}</Chip>
          })}
        </div>
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Orders a month</legend>
        <div className="flex flex-wrap gap-2">
          {ORDER_VOLUMES.map((v) => <Chip key={v} active={value.orders_per_month === v} onClick={() => set('orders_per_month', value.orders_per_month === v ? '' : v)}>{v}</Chip>)}
        </div>
      </fieldset>
    </div>
  )
}

/** Numbered steps across the top of the sign-up form. */
export function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Steps">
      {steps.map((s, i) => (
        <li key={s} className="flex min-w-0 items-center gap-2" aria-current={i === current ? 'step' : undefined}>
          <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums transition-colors',
            i < current && 'border-foreground bg-foreground text-background', i === current && 'border-brand bg-brand text-brand-foreground')}>
            {i < current ? <Check className="size-3" strokeWidth={3} /> : i + 1}
          </span>
          <span className={cn('truncate text-[13px]', i === current ? 'font-medium text-foreground' : 'text-muted-foreground', i !== current && 'hidden sm:inline')}>{s}</span>
          {i < steps.length - 1 && <span className="h-px w-5 shrink-0 bg-border sm:w-8" />}
        </li>
      ))}
    </ol>
  )
}

/**
 * "Do you want a Fullfilio online store?" Yes reserves a store address
 * (<name>.<root domain>, or /s/<name> until the platform has a root domain);
 * no publishes nothing.
 */
function StoreChoice({ value, onChange, error }: { value: SignupBusiness; onChange: (next: SignupBusiness) => void; error?: string }) {
  const [edited, setEdited] = useState(Boolean(value.store_slug))
  const name = useDebounce(value.business_name.trim(), 400)
  // Suggest an address from the business name until the person types their own.
  useEffect(() => {
    if (!value.online_store || edited || name.length < 2) return
    let live = true
    void suggestStoreSlug(name).then((slug) => { if (live) onChange({ ...value, store_slug: slug }) }).catch(() => {})
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, value.online_store, edited])
  const slug = useDebounce(value.store_slug, 350)
  const check = useQuery({ queryKey: ['store-slug', slug], enabled: value.online_store && slug.length >= 2, queryFn: () => checkStoreSlug(slug), staleTime: 30_000 })
  const root = check.data?.root_domain
  const option = (on: boolean, icon: React.ReactNode, title: string, text: string) => (
    <button type="button" role="radio" aria-checked={value.online_store === on} onClick={() => onChange({ ...value, online_store: on })}
      className={cn('flex items-start gap-3 rounded-xl border bg-card p-3 text-left transition-colors hover:border-foreground/20',
        value.online_store === on && 'border-brand ring-1 ring-brand hover:border-brand')}>
      <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground', value.online_store === on && 'bg-brand-soft text-brand')}>{icon}</span>
      <span><span className="block text-sm font-medium">{title}</span><span className="block text-xs text-muted-foreground">{text}</span></span>
    </button>
  )
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-sm font-medium">Do you want a Fullfilio online store?</legend>
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
        {option(true, <Store className="size-4" />, 'Yes, open my online store', 'A ready store with checkout, courier booking and its own address.')}
        {option(false, <Unplug className="size-4" />, 'No, I sell elsewhere', 'Facebook, Shopify or WooCommerce only. No store address is created.')}
      </div>
      {value.online_store && (
        <div className="grid gap-1.5 rounded-xl border bg-muted/30 p-3">
          <span className="text-xs font-medium text-muted-foreground">Your store address</span>
          <div className={cn('flex h-10 items-center overflow-hidden rounded-lg border bg-card text-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/15', error && 'border-destructive')}>
            {!root && <span className="shrink-0 pl-3 text-muted-foreground">{window.location.host}/s/</span>}
            <input value={value.store_slug} aria-label="Store address" spellCheck={false} autoCapitalize="none" maxLength={41}
              onChange={(e) => { setEdited(true); onChange({ ...value, store_slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }) }}
              className={cn('h-full min-w-0 flex-1 bg-transparent font-medium outline-none', root ? 'pl-3' : 'pl-0.5')} placeholder="your-shop" />
            {root && <span className="shrink-0 pr-3 text-muted-foreground">.{root}</span>}
            <span className="grid w-9 shrink-0 place-items-center">
              {check.isFetching ? <Loader2 className="size-4 animate-spin text-muted-foreground" />
                : check.data?.available && check.data.slug === value.store_slug ? <Check className="size-4 text-emerald-600" /> : null}
            </span>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p>
            : check.data && !check.data.available && check.data.slug === value.store_slug ? <p className="text-xs text-destructive">{check.data.reason}</p>
              : <p className="text-xs text-muted-foreground">You can connect your own domain later in Store → Website.</p>}
        </div>
      )}
    </fieldset>
  )
}
