import { zodResolver } from '@hookform/resolvers/zod'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Banknote, ChevronDown, Info, Lock, PhoneCall, ShieldAlert, ShieldCheck, Smartphone, Truck } from 'lucide-react'
import { toast } from '@/lib/toast'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { Link, Navigate, useNavigate } from 'react-router'
import { z } from 'zod'
import { Field } from '@/components/common/field'
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
import { type AdvancePaymentValues, validateAdvancePayment } from '@/features/checkout/advance-payment-fields'
import { PhoneCheckIcon, PhoneCheckStatus, phoneCheckState } from '@/features/checkout/phone-check'
import { useDebounce } from '@/hooks/use-debounce'
import { useStoreConfig } from '@/hooks/use-store-config'
import { currentAttribution } from '@/lib/attribution'
import { errorCode, toUserMessage } from '@/lib/errors'
import { formatMoney } from '@/lib/format'
import { isValidPhone, normalizePhone } from '@/lib/phone'
import { cn } from '@/lib/utils'
import { imageUrl } from '@/services/catalog'
import { checkoutQuote, initiatePayment, placeOrder, trackEvent } from '@/services/storefront'
import type { PaymentMethod } from '@/types/domain'

function buildSchema(phonePattern: string) {
  return z.object({
    full_name: z.string().trim().min(2, 'Enter your full name').max(100),
    phone: z.string().trim().refine((v) => isValidPhone(v, phonePattern), 'Enter a valid mobile number'),
    email: z.union([z.literal(''), z.email('Enter a valid email')]),
    address: z.string().trim().min(5, 'Enter your full address (house, road, area)').max(300),
    area: z.string().trim().max(80),
    district: z.string().min(2, 'Choose your district'),
    delivery_method: z.string().min(1),
    payment_method: z.enum(['COD', 'ADVANCE', 'FULL_PAYMENT']),
    customer_note: z.string().max(500),
  })
}
type CheckoutValues = z.infer<ReturnType<typeof buildSchema>>

export const LAST_ORDER_KEY = 'last_order'

function Section({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card p-5 shadow-xs sm:p-6" aria-labelledby={`step-${step}`}>
      <h2 id={`step-${step}`} className="mb-5 flex items-center gap-2.5 text-base font-semibold">
        <span className="flex size-6 items-center justify-center rounded-full bg-foreground text-xs text-background">{step}</span>
        {title}
      </h2>
      {children}
    </section>
  )
}

export default function CheckoutPage() {
  const { data: config } = useStoreConfig()
  const { user } = useAuth()
  const navigate = useNavigate()
  const { items, couponCode, setCoupon, clear } = useCart()
  const [couponInput, setCouponInput] = useState(couponCode)
  const [couponOpen, setCouponOpen] = useState(Boolean(couponCode))
  const [extrasOpen, setExtrasOpen] = useState(false)
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [advance, setAdvance] = useState<AdvancePaymentValues>({ channel: 'BKASH', sender_phone: '', transaction_id: '' })
  const [advanceErrors, setAdvanceErrors] = useState<Partial<Record<keyof AdvancePaymentValues, string>>>({})
  // How the customer pays what is due now: a gateway code (bkash, paystation…) or 'manual' Send Money.
  const [payVia, setPayVia] = useState('')
  const [redirecting, setRedirecting] = useState(false)
  const schema = useMemo(() => buildSchema(config?.phone_pattern ?? '^[0-9]{8,15}$'), [config?.phone_pattern])
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

  const form = useForm<CheckoutValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      full_name: (user?.user_metadata?.full_name as string) ?? '',
      phone: (user?.user_metadata?.phone as string) ?? '',
      email: user?.email ?? '',
      address: '', area: '', district: '',
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
    lead: phoneValid ? { customer_name: watched.full_name?.trim() || null, address: watched.address?.trim() || null } : null,
    attribution: phoneValid ? attribution : null,
  }, 600)

  const trackedCheckout = useRef(false)
  useEffect(() => {
    if (!items.length || trackedCheckout.current) return
    trackedCheckout.current = true
    trackEvent('BEGIN_CHECKOUT')
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

  const placed = useRef(false)
  const place = useMutation({
    meta: { silent: true },
    mutationFn: ({ values, advancePayment }: { values: CheckoutValues; advancePayment: AdvancePaymentValues | null; gateway: string | null }) => placeOrder({
      customer: { full_name: values.full_name, phone: normalizePhone(values.phone), email: values.email || null },
      shipping: { address: values.address, area: values.area || null, city: null, district: values.district, postal_code: null },
      items: cartLines(items),
      delivery_method: values.delivery_method,
      payment_method: values.payment_method,
      coupon_code: couponCode || null,
      customer_note: values.customer_note || null,
      idempotency_key: idempotencyKey,
      advance_payment: advancePayment ? { ...advancePayment, sender_phone: normalizePhone(advancePayment.sender_phone) } : null,
      attribution,
    }),
    onSuccess: async ({ order, payment_error }, { values, gateway }) => {
      // Set before clearing the cart: the mutation is not "success" yet during this
      // callback, and an empty cart would otherwise redirect to /cart first.
      placed.current = true
      const phone = normalizePhone(values.phone)
      sessionStorage.setItem(LAST_ORDER_KEY, JSON.stringify({ order_number: order.order_number, phone }))
      trackEvent('PURCHASE')
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
  const requirement = currentPhone && quote.data?.phone === currentPhone ? quote.data.payment_requirement : null
  const checkingPhone = phoneValid && !requirement && !(quote.error && !quote.isFetching)
  const checkState = phoneValid ? phoneCheckState(checkingPhone, requirement, method) : null
  const blocked = requirement?.mode === 'BLOCKED'
  const manual = config?.payments.providers.find((p) => p.type === 'manual')
  const walletAccounts = (manual?.accounts ?? []).filter((a) => ['BKASH', 'NAGAD', 'ROCKET'].includes(a.channel) && a.number)
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
    <AdvancePay title={title} note={note} amount={payNow} gateways={gateways} accounts={walletAccounts} via={via} onVia={(v) => { setPayVia(v); setAdvanceErrors({}) }}
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
    : gateway ? <><Lock /> Pay {formatMoney(payNow)} with {gatewayName}</>
    : <><Lock /> Confirm order</>

  return (
    <div className="mx-auto max-w-5xl px-4 pt-6 pb-32 lg:pb-14">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Checkout</h1>
        <Link to="/cart" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Cart</Link>
      </div>

      <form id="checkout" onSubmit={submit} className="grid gap-5 lg:grid-cols-[1fr_360px] lg:items-start lg:gap-8" noValidate>
        <div className="space-y-5">
          <Section step={1} title="Delivery details">
            <div className="grid items-start gap-4 sm:grid-cols-2">
              <Field label="Full name" htmlFor="full_name" error={form.formState.errors.full_name?.message}>
                <Input id="full_name" autoComplete="name" className="h-11" {...form.register('full_name')} aria-invalid={!!form.formState.errors.full_name} />
              </Field>
              <div className="grid gap-1.5">
                <Field label="Mobile number" htmlFor="phone" error={form.formState.errors.phone?.message}>
                  <div className="relative">
                    <Input id="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="01XXXXXXXXX" className="h-11 pr-10"
                      {...form.register('phone')} aria-invalid={!!form.formState.errors.phone} aria-describedby="phone-check" />
                    <PhoneCheckIcon state={checkState} />
                  </div>
                </Field>
                <div id="phone-check">
                  {checkState ? <PhoneCheckStatus state={checkState} requirement={requirement} />
                    : !form.formState.errors.phone && <p className="text-xs text-muted-foreground">We'll call or text about your delivery</p>}
                </div>
              </div>
              <Field label="Full address" htmlFor="address" error={form.formState.errors.address?.message} className="sm:col-span-2">
                <Textarea id="address" rows={2} autoComplete="street-address" placeholder="House, road, area" className="min-h-0 resize-none"
                  {...form.register('address')} aria-invalid={!!form.formState.errors.address} />
              </Field>
              <Field label="District" error={form.formState.errors.district?.message}>
                <Controller control={form.control} name="district" render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="h-11 w-full" aria-invalid={!!form.formState.errors.district}><SelectValue placeholder="Choose district" /></SelectTrigger>
                    <SelectContent className="max-h-72">{districts.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
                  </Select>
                )} />
              </Field>
              <Field label="Area / Thana" htmlFor="area">
                <Input id="area" className="h-11" placeholder="e.g. Dhanmondi" {...form.register('area')} />
              </Field>
              {methods.length > 1 && (
                <Field label="Delivery" className="sm:col-span-2">
                  <Controller control={form.control} name="delivery_method" render={({ field }) => (
                    <RadioGroup value={field.value} onValueChange={field.onChange} className="grid gap-2 sm:grid-cols-2">
                      {methods.map((m) => (
                        <Label key={m.code} className="flex cursor-pointer items-center gap-3 rounded-xl border p-3 font-normal has-[[data-state=checked]]:border-foreground has-[[data-state=checked]]:bg-muted/40">
                          <RadioGroupItem value={m.code} /> <span className="flex-1">{m.name}</span>
                          {Number(m.extra_charge) > 0 && <span className="text-muted-foreground">+{formatMoney(m.extra_charge)}</span>}
                        </Label>
                      ))}
                    </RadioGroup>
                  )} />
                </Field>
              )}
            </div>
            {extrasOpen ? (
              <div className="mt-4 grid gap-4 border-t pt-4 sm:grid-cols-2">
                <Field label="Email (optional)" htmlFor="email" error={form.formState.errors.email?.message}>
                  <Input id="email" type="email" autoComplete="email" className="h-11" {...form.register('email')} />
                </Field>
                <Field label="Note for delivery (optional)" htmlFor="customer_note">
                  <Input id="customer_note" className="h-11" placeholder="e.g. call before coming" {...form.register('customer_note')} />
                </Field>
              </div>
            ) : (
              <button type="button" onClick={() => setExtrasOpen(true)} className="mt-4 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                + Add email or a delivery note
              </button>
            )}
          </Section>

          <Section step={2} title="Payment">
            {!phoneValid ? (
              <p className="rounded-xl border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">Enter your mobile number to see how you can pay.</p>
            ) : checkingPhone ? (
              <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-5 text-sm text-muted-foreground" role="status">
                <Spinner /> Checking payment options…
              </div>
            ) : blocked ? (
              <div className="flex gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900" role="alert">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="font-medium">{requirement?.message}</p>
                  {config?.store.phone && <p className="mt-1">Call us: <a href={`tel:${config.store.phone}`} className="font-medium underline">{config.store.phone}</a></p>}
                </div>
              </div>
            ) : advanceRequired ? (
              collectAtCheckout ? (
                advancePay('Pay the delivery charge in advance',
                  <>Then pay the remaining <Money value={requirement?.remaining_cod ?? Math.max(total - payNow, 0)} /> in cash when your parcel arrives.</>)
              ) : (
                <div className="flex gap-3 rounded-xl bg-amber-50 p-4 text-sm text-amber-950" role="status">
                  <Info className="mt-0.5 size-4 shrink-0" />
                  <div>
                    <p className="font-medium">{requirement?.message}</p>
                    <p className="mt-1">You'll see how to pay after you confirm. The rest is paid on delivery.</p>
                  </div>
                </div>
              )
            ) : (
              <div className="space-y-4">
                {requirement?.mode === 'REVIEW' && (
                  <p className="flex items-center gap-2 rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-950" role="status">
                    <PhoneCall className="size-4 shrink-0" /> We'll call you to confirm this order before it ships.
                  </p>
                )}
                <Controller control={form.control} name="payment_method" render={({ field }) => (
                  <RadioGroup value={field.value} onValueChange={field.onChange} className={cn('grid gap-2', paymentOptions.length > 1 && 'sm:grid-cols-2')}>
                    {paymentOptions.map((o) => (
                      <Label key={o.value} className="group flex cursor-pointer items-center gap-3 rounded-xl border p-3.5 font-normal transition-colors has-[[data-state=checked]]:border-foreground has-[[data-state=checked]]:bg-muted/40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50">
                        <RadioGroupItem value={o.value} className="sr-only" />
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted"><o.icon className="size-4" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{o.label}</span>
                          <span className="block text-xs text-muted-foreground">{o.hint}</span>
                        </span>
                        <span className="size-4 shrink-0 rounded-full border-2 border-muted-foreground/30 transition-all group-has-[[data-state=checked]]:border-[5px] group-has-[[data-state=checked]]:border-foreground" aria-hidden />
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
        </div>

        <aside className="lg:sticky lg:top-24">
          <div className="rounded-2xl border bg-card p-5 shadow-xs sm:p-6">
            <h2 className="mb-4 text-base font-semibold">Your order <span className="font-normal text-muted-foreground">· {itemCount} item{itemCount === 1 ? '' : 's'}</span></h2>
            <ul className="max-h-60 space-y-3 overflow-y-auto">
              {items.map((item) => (
                <li key={item.variantId} className="flex items-center gap-3 text-sm">
                  <div className="relative shrink-0">
                    <img src={imageUrl(item.image, 100)} alt="" className="size-12 rounded-lg bg-muted object-cover" />
                    <span className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-[10px] font-medium text-background">{item.quantity}</span>
                  </div>
                  <div className="min-w-0 flex-1"><p className="truncate">{item.name}</p>{item.variantTitle && <p className="text-xs text-muted-foreground">{item.variantTitle}</p>}</div>
                  <Money value={q?.lines.find((l) => l.variant_id === item.variantId)?.line_subtotal ?? item.price * item.quantity} />
                </li>
              ))}
            </ul>

            <div className="mt-4 border-t pt-3">
              {couponOpen ? (
                <div className="flex gap-2">
                  <Input value={couponInput} onChange={(e) => setCouponInput(e.target.value.toUpperCase())} placeholder="Coupon code" aria-label="Coupon code" />
                  <Button type="button" variant="outline" onClick={() => setCoupon(couponInput)}>Apply</Button>
                </div>
              ) : (
                <button type="button" onClick={() => setCouponOpen(true)} className="flex w-full items-center justify-between text-sm text-muted-foreground hover:text-foreground">
                  Have a coupon code? <ChevronDown className="size-4" />
                </button>
              )}
              {couponCode && q?.coupon && (
                <p className={cn('mt-2 text-xs', q.coupon.valid ? 'text-emerald-700' : 'text-destructive')}>
                  {q.coupon.message} · <button type="button" className="underline" onClick={() => { setCoupon(''); setCouponInput('') }}>Remove</button>
                </p>
              )}
            </div>

            <dl className="mt-3 space-y-2 border-t pt-3 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd><Money value={q?.subtotal ?? 0} /></dd></div>
              {Number(q?.coupon_discount) > 0 && <div className="flex justify-between text-emerald-700"><dt>Discount</dt><dd><Money value={-(q?.coupon_discount ?? 0)} /></dd></div>}
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Delivery</dt>
                <dd>{!watched.district ? <span className="text-muted-foreground">Choose district</span> : delivery <= 0 ? 'Free' : <Money value={delivery} />}</dd>
              </div>
              <div className="flex justify-between border-t pt-3 text-base font-semibold"><dt>Total</dt><dd><Money value={total} /></dd></div>
              {payNow > 0 && (
                <div className="space-y-1.5 rounded-xl bg-muted/60 p-3">
                  <div className="flex justify-between font-medium"><dt>Pay now</dt><dd><Money value={payNow} /></dd></div>
                  <div className="flex justify-between text-muted-foreground"><dt>On delivery</dt><dd><Money value={Math.max(total - payNow, 0)} /></dd></div>
                </div>
              )}
              {q?.delivery_zone?.estimated_days && watched.district && (
                <p className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground"><Truck className="size-3.5" /> Delivery in {q.delivery_zone.estimated_days}</p>
              )}
            </dl>

            {stockErrors.map((e) => <p key={e.variant_id} className="mt-3 text-sm text-destructive">{e.message}</p>)}
            {quote.error && <p className="mt-3 text-sm text-destructive">{toUserMessage(quote.error)}</p>}
            {submitError && (
              <div className="mt-4 flex gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-800" role="alert">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{submitError}{submitCode === 'INSUFFICIENT_STOCK' && <> <Link to="/cart" className="underline">Update cart</Link></>}</span>
              </div>
            )}

            <Button type="submit" size="lg" className="mt-5 hidden h-12 w-full rounded-xl text-base lg:flex" disabled={!canSubmit}>{buttonContent}</Button>
            <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5" /> Your details are only used to deliver this order
            </p>
          </div>
        </aside>

        {/* Phones: total and confirm button always in reach. */}
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden">
          {submitError && <p className="mb-2 text-xs text-destructive">{submitError}</p>}
          <div className="mx-auto flex max-w-5xl items-center gap-4">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{payNow > 0 ? 'Pay now' : 'Total'}</p>
              <p className="text-lg leading-tight font-semibold"><Money value={payNow > 0 ? payNow : total} /></p>
            </div>
            <Button type="submit" size="lg" className="h-12 flex-1 rounded-xl text-base" disabled={!canSubmit}>{buttonContent}</Button>
          </div>
        </div>
      </form>
    </div>
  )
}
