import { zodResolver } from '@hookform/resolvers/zod'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Banknote, ChevronDown, Info, Lock, PhoneCall, ShieldAlert, ShieldCheck, ShoppingBag, Smartphone, Tag, Truck } from 'lucide-react'
import { toast } from '@/lib/toast'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { Link, Navigate, useHref, useNavigate } from 'react-router'
import { z } from 'zod'
import { Money } from '@/components/common/money'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { cartLines, useCart } from '@/features/cart/cart-store'
import { AdvancePay } from '@/features/checkout/advance-pay'
import { type CheckoutFieldModes, checkoutFieldModes } from '@/features/checkout/fields'
import { type AdvancePaymentValues, validateAdvancePayment } from '@/features/checkout/advance-payment-fields'
import { PhoneCheckIcon, PhoneCheckStatus, phoneCheckState } from '@/features/checkout/phone-check'
import { adEvent, adPurchase, browserIds } from '@/features/storefront/ad-pixels'
import { useDebounce } from '@/hooks/use-debounce'
import { useStoreConfig } from '@/hooks/use-store-config'
import { currentAttribution } from '@/lib/attribution'
import { errorCode, toUserMessage } from '@/lib/errors'
import { formatMoney } from '@/lib/format'
import { isValidPhone, normalizePhone } from '@/lib/phone'
import { cn } from '@/lib/utils'
import { imageUrl } from '@/services/catalog'
import { checkoutQuote, initiatePayment, placeOrder, trackEvent } from '@/services/storefront'
import type { CheckoutFieldMode, PaymentMethod } from '@/types/domain'

/** A box the store can switch off, make optional or make required (Settings → Checkout fields). */
const text = (mode: CheckoutFieldMode, max: number, message: string) =>
  mode === 'required' ? z.string().trim().min(1, message).max(max) : z.string().trim().max(max)

function buildSchema(phonePattern: string, f: CheckoutFieldModes) {
  const split = f.last_name !== 'hidden'
  return z.object({
    first_name: z.string().trim().min(2, split ? 'Enter your first name' : 'Enter your full name').max(split ? 60 : 100),
    last_name: text(f.last_name, 39, 'Enter your last name'),
    phone: z.string().trim().refine((v) => isValidPhone(v, phonePattern), 'Enter a valid mobile number'),
    email: f.email === 'required' ? z.email('Enter a valid email') : z.union([z.literal(''), z.email('Enter a valid email')]),
    address: z.string().trim().min(5, 'Enter your full address (house, road, area)').max(240),
    apartment: text(f.apartment, 58, 'Enter apartment, suite, etc.'),
    area: text(f.area, 80, 'Enter your area / thana'),
    district: z.string().min(2, 'Choose your district'),
    postal_code: text(f.postal_code, 12, 'Enter your postal code'),
    delivery_method: z.string().min(1),
    payment_method: z.enum(['COD', 'ADVANCE', 'FULL_PAYMENT']),
    customer_note: text(f.note, 500, 'Add a note for your order'),
  })
}
const fullName = (v: { first_name?: string; last_name?: string }) => [v.first_name?.trim(), v.last_name?.trim()].filter(Boolean).join(' ')
/** The second address line goes after the street address (the order keeps one address). */
const fullAddress = (v: { address?: string; apartment?: string }) => [v.address?.trim(), v.apartment?.trim()].filter(Boolean).join(', ')
type CheckoutValues = z.infer<ReturnType<typeof buildSchema>>

export const LAST_ORDER_KEY = 'last_order'

function Section({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-lg font-semibold tracking-tight">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** A Shopify-style box: the placeholder is the label; the error shows underneath. */
function Box({ error, className, children }: { error?: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn('grid gap-1', className)}>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
const box = 'h-11 rounded-[6px] bg-background px-3 text-sm shadow-none'
/** Bordered list of choices (shipping, payment): rows share borders, the chosen one is outlined. */
const choiceList = 'overflow-hidden rounded-[6px] border'
/** Shopify's filled radio: a solid dot in the theme colour with a white centre. */
const radio = 'data-[state=checked]:bg-primary [&_svg]:size-1.5 [&_svg]:fill-primary-foreground'
const choiceRow = 'relative flex cursor-pointer items-center gap-3 border-b px-4 py-3.5 text-sm font-normal last:border-b-0 has-[[data-state=checked]]:bg-primary/[0.04] has-[[data-state=checked]]:shadow-[inset_0_0_0_1px_var(--primary)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50'

export default function CheckoutPage() {
  const { data: config } = useStoreConfig()
  const { user } = useAuth()
  const navigate = useNavigate()
  const { items, couponCode, setCoupon, clear } = useCart()
  const [couponInput, setCouponInput] = useState(couponCode)
  const [mobileDiscount, setMobileDiscount] = useState(Boolean(couponCode))
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [advance, setAdvance] = useState<AdvancePaymentValues>({ channel: 'BKASH', sender_phone: '', transaction_id: '' })
  const [advanceErrors, setAdvanceErrors] = useState<Partial<Record<keyof AdvancePaymentValues, string>>>({})
  // How the customer pays what is due now: a gateway code (bkash, paystation…) or 'manual' Send Money.
  const [payVia, setPayVia] = useState('')
  const [redirecting, setRedirecting] = useState(false)
  const fields = useMemo(() => checkoutFieldModes(config?.storefront.checkout_fields), [config?.storefront.checkout_fields])
  const schema = useMemo(() => buildSchema(config?.phone_pattern ?? '^[0-9]{8,15}$', fields), [config?.phone_pattern, fields])
  // Where this visitor came from (ad, search, direct…), sent with the quote and the order.
  const [attribution] = useState(() => currentAttribution())

  const paymentOptions = useMemo(() => {
    const p = config?.payments
    const providers = p?.providers ?? []
    const codEnabled = p?.cod_enabled !== false
    return [
      codEnabled && { value: 'COD' as const, label: 'Cash on delivery', hint: 'Pay when your parcel arrives', icon: Banknote },
      p?.full_payment_enabled && providers.length > 0 && {
        value: 'FULL_PAYMENT' as const, label: 'Pay now',
        hint: providers.some((x) => x.type === 'redirect') ? 'bKash, Nagad or card' : 'bKash or Nagad', icon: Smartphone,
      },
      // Stores without cash on delivery can still take part payment up front.
      !codEnabled && p?.advance_enabled && providers.length > 0 && { value: 'ADVANCE' as const, label: 'Pay delivery charge now', hint: 'Rest on delivery', icon: Truck },
    ].filter(Boolean) as Array<{ value: PaymentMethod; label: string; hint: string; icon: typeof Banknote }>
  }, [config])

  // A saved full name fills "First name" and "Last name" (or the one "Full name" box).
  const splitName = (name: string) => {
    if (fields.last_name === 'hidden') return { first_name: name, last_name: '' }
    const [first = '', ...rest] = name.trim().split(/\s+/)
    return { first_name: first, last_name: rest.join(' ') }
  }
  const form = useForm<CheckoutValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      ...splitName((user?.user_metadata?.full_name as string) ?? ''),
      phone: (user?.user_metadata?.phone as string) ?? '',
      email: user?.email ?? '',
      address: '', apartment: '', area: '', district: '', postal_code: '',
      delivery_method: 'standard',
      payment_method: 'COD',
      customer_note: '',
    },
  })
  const watched = useWatch({ control: form.control })
  const phoneValid = Boolean(watched.phone && config && isValidPhone(watched.phone, config.phone_pattern))
  const method = (watched.payment_method ?? 'COD') as PaymentMethod
  const quoteInput = useDebounce({
    items: cartLines(items),
    district: watched.district || null,
    area: watched.area || null,
    delivery_method: watched.delivery_method ?? 'standard',
    coupon_code: couponCode || null,
    phone: phoneValid ? normalizePhone(watched.phone ?? '') : null,
    payment_method: method,
    lead: phoneValid ? { customer_name: fullName(watched) || null, address: fullAddress(watched) || null } : null,
    attribution: phoneValid ? attribution : null,
  }, 600)

  const trackedCheckout = useRef(false)
  useEffect(() => {
    if (!items.length || trackedCheckout.current) return
    trackedCheckout.current = true
    trackEvent('BEGIN_CHECKOUT')
    adEvent('InitiateCheckout', {
      value: items.reduce((n, i) => n + i.price * i.quantity, 0), currency: config?.store.currency || 'BDT',
      contents: items.map((i) => ({ id: i.productId, name: i.name, quantity: i.quantity, price: i.price })),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (paymentOptions.length && !paymentOptions.some((o) => o.value === form.getValues('payment_method'))) {
      form.setValue('payment_method', paymentOptions[0].value)
    }
  }, [paymentOptions, form])

  const quote = useQuery({
    queryKey: ['checkout-quote', quoteInput],
    enabled: quoteInput.items.length > 0,
    placeholderData: keepPreviousData,
    // Remember which number the answer is for, so editing the address doesn't re-check it.
    queryFn: async () => ({ ...(await checkoutQuote(quoteInput)), phone: quoteInput.phone }),
    retry: false,
  })
  // The courier check starts the moment the number is complete (no waiting for the price first),
  // so it runs while the customer types the address and is usually done before Payment.
  // Until it answers the customer sees "checking", never a guessed cash on delivery.
  const livePhone = phoneValid ? normalizePhone(watched.phone ?? '') : null
  const quoteDone = Boolean(livePhone && quote.data?.phone === livePhone && quote.data.risk !== 'pending')
  // One lookup per number: changing the district or the payment method while it runs must not
  // start another (the price quote reuses the finished check for whatever is chosen then).
  const riskCheck = useQuery({
    queryKey: ['checkout-risk', livePhone],
    enabled: !!livePhone && !quoteDone,
    staleTime: 5 * 60_000,
    queryFn: async () => ({ ...(await checkoutQuote({ ...quoteInput, phone: livePhone, check: true })), phone: livePhone }),
    retry: false,
  })
  const riskPending = !!livePhone && !quoteDone && !riskCheck.data

  // When the lookup is done, price again with what is chosen now (it may have changed meanwhile).
  const refetchQuote = quote.refetch
  useEffect(() => {
    if (riskCheck.data) void refetchQuote()
  }, [riskCheck.data, refetchQuote])
  // Never keep the customer waiting: after 8 seconds the decision is made when the order is placed.
  const [slowCheck, setSlowCheck] = useState<string | null>(null)
  useEffect(() => {
    if (!riskPending || !livePhone) return
    const phone = livePhone
    const timer = setTimeout(() => setSlowCheck(phone), 8_000)
    return () => clearTimeout(timer)
  }, [riskPending, livePhone])

  const placed = useRef(false)
  // The order page to come back to from bKash / PayStation without paying (the cart is empty by then).
  const orderPage = useHref('/order-success')
  const leftFor = useRef<string | null>(null)
  useEffect(() => {
    // Back from the gateway and the browser restored this page as it was ("Opening bKash…"): show the order page instead.
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted && leftFor.current) navigate(leftFor.current, { replace: true })
    }
    window.addEventListener('pageshow', onShow)
    return () => window.removeEventListener('pageshow', onShow)
  }, [navigate])
  const place = useMutation({
    meta: { silent: true },
    mutationFn: ({ values, advancePayment }: { values: CheckoutValues; advancePayment: AdvancePaymentValues | null; gateway: string | null }) => placeOrder({
      customer: { full_name: fullName(values), phone: normalizePhone(values.phone), email: values.email || null },
      shipping: { address: fullAddress(values), area: values.area || null, city: null, district: values.district, postal_code: values.postal_code || null },
      items: cartLines(items),
      delivery_method: values.delivery_method,
      payment_method: values.payment_method,
      coupon_code: couponCode || null,
      customer_note: values.customer_note || null,
      idempotency_key: idempotencyKey,
      advance_payment: advancePayment ? { ...advancePayment, sender_phone: normalizePhone(advancePayment.sender_phone) } : null,
      // The browser's ad ids as they are now (the pixels may have set them after the page opened).
      attribution: { ...attribution, browser: browserIds() },
    }),
    onSuccess: async ({ order, payment_error, tracking }, { values, gateway }) => {
      // Set before clearing the cart: the mutation is not "success" yet during this
      // callback, and an empty cart would otherwise redirect to /cart first.
      placed.current = true
      const phone = normalizePhone(values.phone)
      sessionStorage.setItem(LAST_ORDER_KEY, JSON.stringify({ order_number: order.order_number, phone }))
      trackEvent('PURCHASE')
      adPurchase(tracking?.purchase)
      clear()
      setIdempotencyKey(crypto.randomUUID())
      if (payment_error) toast.warning(`Order placed, but your payment details need another look: ${payment_error}`)
      const params = new URLSearchParams({ order: order.order_number })
      if (order.merged) params.set('merged', '1')
      // Straight on to bKash / PayStation. The order counts as paid only when the
      // gateway confirms it to our server, never because the customer came back.
      if (gateway && Number(order.amount_due_now) > 0) {
        setRedirecting(true)
        try {
          const res = await initiatePayment({
            order_number: order.order_number, phone, provider: gateway,
            purpose: values.payment_method === 'FULL_PAYMENT' ? 'FULL' : 'ADVANCE',
          })
          if (res.redirectUrl) {
            // The back button on the gateway then opens the order page, where the customer
            // can pay again with this or another method, not an empty checkout.
            leftFor.current = `/order-success?${params}`
            window.history.replaceState(window.history.state, '', `${orderPage}?${params}`)
            window.location.assign(res.redirectUrl)
            return
          }
        } catch {
          // The order is placed; the success page offers every way to pay.
        }
        setRedirecting(false)
        params.set('payment', 'unavailable')
      }
      navigate(`/order-success?${params}`, { replace: true })
    },
  })

  if (!items.length && !place.isSuccess && !placed.current) return <Navigate to="/cart" replace />

  const q = quote.data?.quote
  // Only use a decision made for the number currently typed.
  const currentPhone = phoneValid ? normalizePhone(watched.phone ?? '') : null
  const forPhone = currentPhone && quote.data?.phone === currentPhone ? quote.data : null
  const fromCheck = riskCheck.data?.phone === currentPhone ? riskCheck.data : null
  // The current quote decides once it has the check; until then the check's own answer does.
  const checked = forPhone && forPhone.risk !== 'pending' ? forPhone : fromCheck ?? forPhone
  const requirement = checked?.payment_requirement ?? null
  // The decision is made when the order is placed (lookup limit reached, check failed to start).
  const decided = checked?.risk === 'checked' || checked?.risk === 'off'
  const deferred = !!currentPhone && (checked?.risk === 'deferred' || (!decided && (!!riskCheck.error || slowCheck === currentPhone)))
  const checkingPhone = phoneValid && !requirement && !deferred && !(quote.error && !quote.isFetching)
  const checkState = phoneValid ? phoneCheckState(checkingPhone, requirement, method, deferred) : null
  const blocked = requirement?.mode === 'BLOCKED'
  const manual = config?.payments.providers.find((p) => p.type === 'manual')
  const walletAccounts = (manual?.accounts ?? []).filter((a) => ['BKASH', 'NAGAD', 'ROCKET'].includes(a.channel) && a.number)
  const districtChosen = Boolean(watched.district)
  const payNow = !checkingPhone && requirement && (requirement.mode === 'ADVANCE' || requirement.mode === 'FULL') ? requirement.amount : 0
  // The risk check asked for an advance although the customer chose cash on delivery.
  const advanceRequired = method === 'COD' && payNow > 0
  const gateways = (config?.payments.providers ?? []).filter((p) => p.type === 'redirect').map((p) => ({ code: p.code, label: p.label }))
  // Take the payment right here: online through a gateway, or Send Money with a TrxID.
  const collectAtCheckout = payNow > 0 && (gateways.length > 0 || walletAccounts.length > 0)
  const via = payVia === 'manual' && walletAccounts.length ? 'manual'
    : gateways.find((g) => g.code === payVia)?.code ?? gateways[0]?.code ?? 'manual'
  const gateway = collectAtCheckout && via !== 'manual' ? gateways.find((g) => g.code === via) ?? null : null
  const walletChannel = walletAccounts.some((a) => a.channel === advance.channel) ? advance.channel
    : (walletAccounts[0]?.channel as AdvancePaymentValues['channel'] | undefined) ?? 'BKASH'
  const advancePay = (title: string, note?: ReactNode) => (
    <AdvancePay title={title} note={note} amount={districtChosen ? payNow : null} gateways={gateways} accounts={walletAccounts} via={via} onVia={(v) => { setPayVia(v); setAdvanceErrors({}) }}
      manual={{ ...advance, channel: walletChannel }} onManual={(v) => { setAdvance(v); setAdvanceErrors({}) }} errors={advanceErrors} />
  )

  const submit = form.handleSubmit((values) => {
    let advancePayment: AdvancePaymentValues | null = null
    if (collectAtCheckout && via === 'manual') {
      advancePayment = { ...advance, channel: walletChannel }
      const errors = validateAdvancePayment(advancePayment, (p) => isValidPhone(p, config?.phone_pattern ?? '^[0-9]{8,15}$'))
      setAdvanceErrors(errors)
      if (Object.keys(errors).length) {
        document.getElementById(errors.sender_phone ? 'adv-sender' : 'adv-trx')?.focus()
        return
      }
    }
    place.mutate({ values, advancePayment, gateway: gateway?.code ?? null })
  }, (errors) => {
    // Something is missing: bring it into view (on a phone it is usually far above the button) and say what.
    const first = (['phone', 'email', 'first_name', 'last_name', 'address', 'apartment', 'district', 'area', 'postal_code', 'customer_note'] as const).find((k) => errors[k])
    if (!first) return
    toast.error(errors[first]?.message ?? 'Check your delivery details')
    requestAnimationFrame(() => {
      const el = document.getElementById(first)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el?.focus({ preventScroll: true })
    })
  })
  const stockErrors = q?.stock_errors ?? []
  const districts = config?.delivery.districts ?? []
  const methods = config?.delivery.methods ?? [{ code: 'standard', name: 'Standard delivery', extra_charge: 0 }]
  const total = Number(q?.total ?? 0)
  const delivery = Number(q?.delivery_charge ?? 0) - Number(q?.delivery_discount ?? 0)
  const itemCount = items.reduce((s, i) => s + i.quantity, 0)

  const submitError = place.error ? toUserMessage(place.error) : null
  const submitCode = place.error ? errorCode(place.error) : null
  const busy = place.isPending || redirecting
  const canSubmit = !busy && !blocked && stockErrors.length === 0 && !checkingPhone
  const gatewayName = gateway?.label.replace(/^Pay with /, '').replace(/ \(.*\)$/, '')
  const buttonContent = busy || checkingPhone
    ? <><Spinner /> {checkingPhone ? 'Checking…' : redirecting ? `Opening ${gatewayName}…` : 'Placing order…'}</>
    : gateway ? <><Lock /> {districtChosen ? `Pay ${formatMoney(payNow)} with ${gatewayName}` : `Pay with ${gatewayName}`}</>
    : <><Lock /> Complete order</>

  const err = form.formState.errors
  const optional = (label: string, mode: CheckoutFieldMode) => (mode === 'optional' ? `${label} (optional)` : label)
  const split = fields.last_name !== 'hidden'
  const selectedMethod = methods.find((m) => m.code === watched.delivery_method) ?? methods[0]
  // The quote prices the chosen method; the others differ by their extra charge.
  const baseDelivery = delivery - Number(selectedMethod?.extra_charge ?? 0)
  const currency = config?.store.currency || 'BDT'
  // Until the server prices the cart, the cart's own prices.
  const subtotal = q?.subtotal ?? items.reduce((n, i) => n + i.price * i.quantity, 0)

  const summary = (
    <div className="space-y-5">
      <ul className="space-y-4">
        {items.map((item) => (
          <li key={item.variantId} className="flex items-center gap-4 text-sm">
            <div className="relative shrink-0">
              <img src={imageUrl(item.image, 120)} alt="" className="size-16 rounded-[6px] border bg-background object-cover" />
              <span className="absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full bg-foreground text-[11px] font-medium text-background">{item.quantity}</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{item.name}</p>
              {item.variantTitle && <p className="text-xs text-muted-foreground">{item.variantTitle}</p>}
            </div>
            <Money value={q?.lines.find((l) => l.variant_id === item.variantId)?.line_subtotal ?? item.price * item.quantity} />
          </li>
        ))}
      </ul>

      <div>
        <div className="flex gap-2">
          <Input value={couponInput} onChange={(e) => setCouponInput(e.target.value.toUpperCase())} placeholder="Discount code" aria-label="Discount code" className={box}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (couponInput.trim()) setCoupon(couponInput) } }} />
          <Button type="button" variant="outline" className="h-11 rounded-[6px] px-5" disabled={!couponInput.trim()} onClick={() => setCoupon(couponInput)}>Apply</Button>
        </div>
        {couponCode && q?.coupon && (
          <p className={cn('mt-2 text-xs', q.coupon.valid ? 'text-emerald-700' : 'text-destructive')}>
            {q.coupon.message} · <button type="button" className="underline" onClick={() => { setCoupon(''); setCouponInput('') }}>Remove</button>
          </p>
        )}
      </div>

      <dl className="space-y-2 text-sm">
        <div className="flex justify-between"><dt>Subtotal · {itemCount} item{itemCount === 1 ? '' : 's'}</dt><dd><Money value={subtotal} /></dd></div>
        {Number(q?.coupon_discount) > 0 && <div className="flex justify-between text-emerald-700"><dt>Discount</dt><dd><Money value={-(q?.coupon_discount ?? 0)} /></dd></div>}
        <div className="flex justify-between">
          <dt>Shipping</dt>
          <dd>{!districtChosen ? <span className="text-muted-foreground">Enter district</span> : delivery <= 0 ? 'Free' : <Money value={delivery} />}</dd>
        </div>
        <div className="flex items-baseline justify-between pt-2 text-lg font-semibold">
          <dt>Total</dt>
          <dd className="flex items-baseline gap-2">
            {districtChosen ? <><span className="text-xs font-normal text-muted-foreground">{currency}</span><Money value={total} /></> : <span className="text-sm font-normal text-muted-foreground">after shipping</span>}
          </dd>
        </div>
        {payNow > 0 && districtChosen && (
          <div className="space-y-1.5 rounded-[6px] border bg-background p-3">
            <div className="flex justify-between font-medium"><dt>Pay now</dt><dd><Money value={payNow} /></dd></div>
            <div className="flex justify-between text-muted-foreground"><dt>On delivery</dt><dd><Money value={Math.max(total - payNow, 0)} /></dd></div>
          </div>
        )}
        {q?.delivery_zone?.estimated_days && districtChosen && (
          <p className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground"><Truck className="size-3.5" /> Delivery in {q.delivery_zone.estimated_days}</p>
        )}
      </dl>
      {stockErrors.map((e) => <p key={e.variant_id} className="text-sm text-destructive">{e.message}</p>)}
      {quote.error && <p className="text-sm text-destructive">{toUserMessage(quote.error)}</p>}
    </div>
  )

  return (
    <div className="relative">
      {/* The order summary's grey panel runs to the right edge on wide screens. */}
      <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 hidden w-1/2 border-l bg-muted/50 lg:block" />
      <form id="checkout" onSubmit={submit} noValidate
        className="relative mx-auto grid max-w-6xl lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">

        {/* Phones: the summary folds away above the form, like Shopify. */}
        <details className="group border-b bg-muted/50 px-4 py-4 lg:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2"><ShoppingBag className="size-4" /> Order summary <ChevronDown className="size-4 transition-transform group-open:rotate-180" /></span>
            <span className="text-base font-semibold">{districtChosen ? <Money value={total} /> : <Money value={subtotal} />}</span>
          </summary>
          <div className="pt-5">{summary}</div>
        </details>

        <div className="space-y-8 px-4 pt-8 pb-12 sm:px-8 lg:pr-12 lg:pb-16 lg:pl-4">
          <Section id="co-contact" title="Contact" aside={!user && <Link to="/login?next=/checkout" className="text-sm underline underline-offset-4">Sign in</Link>}>
            <div className="grid gap-3">
              <Box error={err.phone?.message}>
                <div className="relative">
                  <Input id="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="Mobile number" aria-label="Mobile number" className={cn(box, 'pr-10')}
                    {...form.register('phone')} aria-invalid={!!err.phone} aria-describedby="phone-check" />
                  <PhoneCheckIcon state={checkState} />
                </div>
                <div id="phone-check">
                  {checkState ? <PhoneCheckStatus state={checkState} requirement={requirement} />
                    : !err.phone && <p className="text-xs text-muted-foreground">We'll call or text about your delivery</p>}
                </div>
              </Box>
              {fields.email !== 'hidden' && (
                <Box error={err.email?.message}>
                  <Input id="email" type="email" autoComplete="email" placeholder={optional('Email', fields.email)} aria-label="Email" className={box}
                    {...form.register('email')} aria-invalid={!!err.email} />
                </Box>
              )}
            </div>
          </Section>

          <Section id="co-delivery" title="Delivery">
            <div className="grid grid-cols-2 gap-3">
              <Box error={err.first_name?.message} className={cn(!split && 'col-span-2')}>
                <Input id="first_name" autoComplete={split ? 'given-name' : 'name'} placeholder={split ? 'First name' : 'Full name'} aria-label={split ? 'First name' : 'Full name'} className={box}
                  {...form.register('first_name')} aria-invalid={!!err.first_name} />
              </Box>
              {split && (
                <Box error={err.last_name?.message}>
                  <Input id="last_name" autoComplete="family-name" placeholder={optional('Last name', fields.last_name)} aria-label="Last name" className={box}
                    {...form.register('last_name')} aria-invalid={!!err.last_name} />
                </Box>
              )}
              <Box error={err.address?.message} className="col-span-2">
                <Input id="address" autoComplete="street-address" placeholder="Address (house, road, area)" aria-label="Address" className={box}
                  {...form.register('address')} aria-invalid={!!err.address} />
              </Box>
              {fields.apartment !== 'hidden' && (
                <Box error={err.apartment?.message} className="col-span-2">
                  <Input id="apartment" autoComplete="address-line2" placeholder={optional('Apartment, suite, etc.', fields.apartment)} aria-label="Apartment, suite, etc." className={box}
                    {...form.register('apartment')} aria-invalid={!!err.apartment} />
                </Box>
              )}
              <Box error={err.district?.message} className={cn(fields.area === 'hidden' && fields.postal_code === 'hidden' && 'col-span-2')}>
                <Controller control={form.control} name="district" render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger ref={field.ref} id="district" className={cn(box, 'relative w-full data-[size=default]:h-11', field.value && 'pt-3.5')} aria-label="District" aria-invalid={!!err.district}>
                      {field.value && <span className="pointer-events-none absolute top-1 left-3 text-[11px] text-muted-foreground">District / City</span>}
                      <SelectValue placeholder="District / City" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">{districts.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
                  </Select>
                )} />
              </Box>
              {fields.area !== 'hidden' && (
                <Box error={err.area?.message} className={cn(fields.postal_code !== 'hidden' && 'col-span-1')}>
                  <Input id="area" placeholder={optional('Area / Thana', fields.area)} aria-label="Area / Thana" className={box}
                    {...form.register('area')} aria-invalid={!!err.area} />
                </Box>
              )}
              {fields.postal_code !== 'hidden' && (
                <Box error={err.postal_code?.message} className={cn(fields.area !== 'hidden' && 'col-span-2')}>
                  <Input id="postal_code" inputMode="numeric" autoComplete="postal-code" placeholder={optional('Postal code', fields.postal_code)} aria-label="Postal code" className={box}
                    {...form.register('postal_code')} aria-invalid={!!err.postal_code} />
                </Box>
              )}
              {fields.note !== 'hidden' && (
                <Box error={err.customer_note?.message} className="col-span-2">
                  <Textarea id="customer_note" rows={2} placeholder={optional('Order note, e.g. call before coming', fields.note)} aria-label="Order note"
                    className="min-h-0 resize-none rounded-[6px] bg-background px-3 py-3 text-sm shadow-none" {...form.register('customer_note')} aria-invalid={!!err.customer_note} />
                </Box>
              )}
            </div>
          </Section>

          <Section id="co-shipping" title="Shipping method">
            {!districtChosen ? (
              <p className="rounded-[6px] bg-muted/60 px-4 py-4 text-sm text-muted-foreground">Choose your district to see shipping methods.</p>
            ) : (
              <Controller control={form.control} name="delivery_method" render={({ field }) => (
                <RadioGroup value={field.value} onValueChange={field.onChange} className={cn(choiceList, 'gap-0')}>
                  {methods.map((m) => {
                    const price = Math.max(baseDelivery + Number(m.extra_charge ?? 0), 0)
                    return (
                      <Label key={m.code} className={choiceRow}>
                        <RadioGroupItem value={m.code} className={radio} />
                        <span className="flex-1 font-medium">{m.name}</span>
                        <span>{price <= 0 ? 'Free' : <Money value={price} />}</span>
                      </Label>
                    )
                  })}
                </RadioGroup>
              )} />
            )}
          </Section>

          <Section id="co-payment" title="Payment">
            <p className="-mt-2 mb-3 text-xs text-muted-foreground">All transactions are secure and encrypted.</p>
            {!phoneValid ? (
              <p className="rounded-[6px] bg-muted/60 px-4 py-4 text-sm text-muted-foreground">Enter your mobile number to see how you can pay.</p>
            ) : checkingPhone ? (
              <div className="flex items-center gap-2 rounded-[6px] bg-muted/60 px-4 py-4 text-sm text-muted-foreground" role="status">
                <Spinner /> Checking payment options…
              </div>
            ) : blocked ? (
              <div className="flex gap-3 rounded-[6px] border border-red-200 bg-red-50 p-4 text-sm text-red-900" role="alert">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="font-medium">{requirement?.message}</p>
                  {config?.store.phone && <p className="mt-1">Call us: <a href={`tel:${config.store.phone}`} className="font-medium underline">{config.store.phone}</a></p>}
                </div>
              </div>
            ) : advanceRequired ? (
              collectAtCheckout ? (
                advancePay(`Pay ${requirement?.mode === 'FULL' ? 'for your order' : 'the advance'} to confirm`,
                  <>Then pay the remaining <Money value={requirement?.remaining_cod ?? Math.max(total - payNow, 0)} /> in cash when your parcel arrives.</>)
              ) : (
                <div className="flex gap-3 rounded-[6px] bg-amber-50 p-4 text-sm text-amber-950" role="status">
                  <Info className="mt-0.5 size-4 shrink-0" />
                  <div>
                    <p className="font-medium">{requirement?.message}</p>
                    <p className="mt-1">You'll see how to pay after you confirm. The rest is paid on delivery.</p>
                  </div>
                </div>
              )
            ) : (
              <div className="space-y-3">
                {deferred && (
                  <p className="flex items-center gap-2 rounded-[6px] bg-muted/60 px-4 py-3 text-sm text-muted-foreground" role="status">
                    <Info className="size-4 shrink-0" /> If this order needs an advance, you'll see the amount and how to pay right after you place it.
                  </p>
                )}
                {requirement?.mode === 'REVIEW' && (
                  <p className="flex items-center gap-2 rounded-[6px] bg-sky-50 px-4 py-3 text-sm text-sky-950" role="status">
                    <PhoneCall className="size-4 shrink-0" /> We'll call you to confirm this order before it ships.
                  </p>
                )}
                <Controller control={form.control} name="payment_method" render={({ field }) => (
                  <RadioGroup value={field.value} onValueChange={field.onChange} className={cn(choiceList, 'gap-0')}>
                    {paymentOptions.map((o) => (
                      <Label key={o.value} className={choiceRow}>
                        <RadioGroupItem value={o.value} className={radio} />
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{o.label}</span>
                          <span className="block text-xs text-muted-foreground">{o.hint}</span>
                        </span>
                        <o.icon className="size-4 shrink-0 text-muted-foreground" />
                      </Label>
                    ))}
                  </RadioGroup>
                )} />
                {collectAtCheckout && advancePay(method === 'FULL_PAYMENT' ? 'Pay for your order now' : 'Pay now')}
                {payNow > 0 && !collectAtCheckout && requirement?.message && (
                  <p className="text-sm text-muted-foreground">{requirement.message} You'll see how to pay after you confirm.</p>
                )}
              </div>
            )}
          </Section>

          {submitError && (
            <div className="flex gap-2 rounded-[6px] bg-red-50 p-3 text-sm text-red-800" role="alert">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{submitError}{submitCode === 'INSUFFICIENT_STOCK' && <> <Link to="/cart" className="underline">Update cart</Link></>}</span>
            </div>
          )}
          {/* Phones, like Shopify: discount, total and the button at the end of the form. */}
          <div className="space-y-4 lg:hidden">
            {mobileDiscount ? (
              <div className="flex gap-2">
                <Input value={couponInput} onChange={(e) => setCouponInput(e.target.value.toUpperCase())} placeholder="Discount code" aria-label="Discount code" className={box} autoFocus />
                <Button type="button" variant="outline" className="h-11 rounded-[6px] px-4" disabled={!couponInput.trim()} onClick={() => setCoupon(couponInput)}>Apply</Button>
              </div>
            ) : (
              <button type="button" onClick={() => setMobileDiscount(true)} className="inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1.5 text-xs font-medium">
                <Tag className="size-3.5" /> Add discount
              </button>
            )}
            {couponCode && q?.coupon && (
              <p className={cn('text-xs', q.coupon.valid ? 'text-emerald-700' : 'text-destructive')}>{q.coupon.message}</p>
            )}
            <button type="button" onClick={() => setSummaryOpen((v) => !v)} className="flex w-full items-center gap-3 text-left" aria-expanded={summaryOpen}>
              <span className="relative shrink-0">
                <img src={imageUrl(items[0]?.image ?? null, 80)} alt="" className="size-10 rounded-[6px] border bg-background object-cover" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">Total</span>
                <span className="block text-xs text-muted-foreground">{itemCount} item{itemCount === 1 ? '' : 's'}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">{currency}</span>
                <span className="text-lg font-semibold">{districtChosen ? <Money value={total} /> : <Money value={subtotal} />}</span>
                <ChevronDown className={cn('size-4 transition-transform', summaryOpen && 'rotate-180')} />
              </span>
            </button>
            {summaryOpen && <div className="rounded-[6px] border bg-muted/40 p-4">{summary}</div>}
            {payNow > 0 && districtChosen && (
              <p className="text-sm">Pay now <b><Money value={payNow} /></b> · on delivery <Money value={Math.max(total - payNow, 0)} /></p>
            )}
          </div>
          <div>
            <Button type="submit" size="lg" className="h-12 w-full rounded-[6px] text-base font-semibold lg:h-14" disabled={!canSubmit}>{buttonContent}</Button>
            <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5" /> Your details are only used to deliver this order
            </p>
            <Link to="/policies/privacy" className="mt-6 inline-block text-xs underline underline-offset-4 text-primary">Privacy policy</Link>
          </div>
        </div>

        <aside className="hidden px-4 pt-8 lg:block lg:pl-12">
          <div className="sticky top-24">{summary}</div>
        </aside>

      </form>
    </div>
  )
}
