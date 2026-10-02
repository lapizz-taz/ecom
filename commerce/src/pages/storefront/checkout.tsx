import { zodResolver } from '@hookform/resolvers/zod'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Info, Lock, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { Link, Navigate, useNavigate } from 'react-router'
import { z } from 'zod'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { cartLines, useCart } from '@/features/cart/cart-store'
import { useDebounce } from '@/hooks/use-debounce'
import { useStoreConfig } from '@/hooks/use-store-config'
import { errorCode, toUserMessage } from '@/lib/errors'
import { formatMoney } from '@/lib/format'
import { isValidPhone, normalizePhone } from '@/lib/phone'
import { cn } from '@/lib/utils'
import { imageUrl } from '@/services/catalog'
import { checkoutQuote, placeOrder, storedUtm, trackEvent } from '@/services/storefront'
import type { PaymentMethod } from '@/types/domain'

function buildSchema(phonePattern: string) {
  return z.object({
    full_name: z.string().trim().min(2, 'Enter your full name').max(100),
    phone: z.string().trim().refine((v) => isValidPhone(v, phonePattern), 'Enter a valid mobile number'),
    email: z.union([z.literal(''), z.email('Enter a valid email')]),
    address: z.string().trim().min(5, 'Enter your full address (house, road, area)').max(300),
    area: z.string().trim().max(80),
    city: z.string().trim().max(80),
    district: z.string().min(2, 'Choose your district'),
    postal_code: z.string().trim().max(12),
    delivery_method: z.string().min(1),
    payment_method: z.enum(['COD', 'ADVANCE', 'FULL_PAYMENT']),
    customer_note: z.string().max(500),
  })
}
type CheckoutValues = z.infer<ReturnType<typeof buildSchema>>

export const LAST_ORDER_KEY = 'last_order'

export default function CheckoutPage() {
  const { data: config } = useStoreConfig()
  const { user } = useAuth()
  const navigate = useNavigate()
  const { items, couponCode, setCoupon, clear } = useCart()
  const [couponInput, setCouponInput] = useState(couponCode)
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const schema = useMemo(() => buildSchema(config?.phone_pattern ?? '^[0-9]{8,15}$'), [config?.phone_pattern])

  const paymentOptions = useMemo(() => {
    const p = config?.payments
    const hasPaymentProvider = (p?.providers.length ?? 0) > 0
    return [
      p?.cod_enabled !== false && { value: 'COD' as const, label: 'Cash on delivery', hint: 'Pay when your order arrives' },
      p?.advance_enabled && hasPaymentProvider && { value: 'ADVANCE' as const, label: 'Pay delivery charge now', hint: 'Rest on delivery' },
      p?.full_payment_enabled && hasPaymentProvider && { value: 'FULL_PAYMENT' as const, label: 'Pay in full now', hint: 'bKash, Nagad or card' },
    ].filter(Boolean) as Array<{ value: PaymentMethod; label: string; hint: string }>
  }, [config])

  const form = useForm<CheckoutValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      full_name: (user?.user_metadata?.full_name as string) ?? '',
      phone: (user?.user_metadata?.phone as string) ?? '',
      email: user?.email ?? '',
      address: '', area: '', city: '', district: '', postal_code: '',
      delivery_method: 'standard',
      payment_method: 'COD',
      customer_note: '',
    },
  })
  const watched = useWatch({ control: form.control })
  const phoneValid = Boolean(watched.phone && config && isValidPhone(watched.phone, config.phone_pattern))
  const quoteInput = useDebounce({
    items: cartLines(items),
    district: watched.district || null,
    area: watched.area || null,
    delivery_method: watched.delivery_method ?? 'standard',
    coupon_code: couponCode || null,
    phone: phoneValid ? normalizePhone(watched.phone ?? '') : null,
    payment_method: (watched.payment_method ?? 'COD') as PaymentMethod,
  }, 400)

  useEffect(() => {
    if (items.length) trackEvent('BEGIN_CHECKOUT')
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
    queryFn: () => checkoutQuote(quoteInput),
    retry: false,
  })

  const place = useMutation({
    meta: { silent: true },
    mutationFn: (values: CheckoutValues) => placeOrder({
      customer: { full_name: values.full_name, phone: normalizePhone(values.phone), email: values.email || null },
      shipping: { address: values.address, area: values.area || null, city: values.city || null, district: values.district, postal_code: values.postal_code || null },
      items: cartLines(items),
      delivery_method: values.delivery_method,
      payment_method: values.payment_method,
      coupon_code: couponCode || null,
      customer_note: values.customer_note || null,
      idempotency_key: idempotencyKey,
      utm: storedUtm(),
    }),
    onSuccess: ({ order }, values) => {
      sessionStorage.setItem(LAST_ORDER_KEY, JSON.stringify({ order_number: order.order_number, phone: normalizePhone(values.phone) }))
      trackEvent('PURCHASE')
      clear()
      setIdempotencyKey(crypto.randomUUID())
      navigate(`/order-success?order=${encodeURIComponent(order.order_number)}`, { replace: true })
    },
  })

  if (!items.length && !place.isSuccess) return <Navigate to="/cart" replace />

  const q = quote.data?.quote
  const requirement = quote.data?.payment_requirement
  const blocked = requirement?.mode === 'BLOCKED'
  const stockErrors = q?.stock_errors ?? []
  const districts = config?.delivery.districts ?? []
  const methods = config?.delivery.methods ?? [{ code: 'standard', name: 'Standard delivery', extra_charge: 0 }]

  const submitError = place.error ? toUserMessage(place.error) : null
  const submitCode = place.error ? errorCode(place.error) : null

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold">Checkout</h1>
      <form onSubmit={form.handleSubmit((v) => place.mutate(v))} className="grid gap-8 lg:grid-cols-[1fr_380px]" noValidate>
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle className="text-base">Contact</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Full name" htmlFor="full_name" error={form.formState.errors.full_name?.message} required className="sm:col-span-2">
                <Input id="full_name" autoComplete="name" {...form.register('full_name')} aria-invalid={!!form.formState.errors.full_name} />
              </Field>
              <Field label="Mobile number" htmlFor="phone" error={form.formState.errors.phone?.message} required hint="We'll call or text about your delivery">
                <Input id="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="01XXXXXXXXX" {...form.register('phone')} aria-invalid={!!form.formState.errors.phone} />
              </Field>
              <Field label="Email (optional)" htmlFor="email" error={form.formState.errors.email?.message}>
                <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Delivery address</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Address" htmlFor="address" error={form.formState.errors.address?.message} required className="sm:col-span-2">
                <Textarea id="address" rows={2} autoComplete="street-address" placeholder="House, road, area" {...form.register('address')} aria-invalid={!!form.formState.errors.address} />
              </Field>
              <Field label="District" error={form.formState.errors.district?.message} required>
                <Controller control={form.control} name="district" render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger aria-invalid={!!form.formState.errors.district}><SelectValue placeholder="Choose district" /></SelectTrigger>
                    <SelectContent className="max-h-72">{districts.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
                  </Select>
                )} />
              </Field>
              <Field label="Area / Thana" htmlFor="area">
                <Input id="area" {...form.register('area')} />
              </Field>
              <Field label="City (optional)" htmlFor="city"><Input id="city" autoComplete="address-level2" {...form.register('city')} /></Field>
              <Field label="Postal code (optional)" htmlFor="postal_code"><Input id="postal_code" autoComplete="postal-code" {...form.register('postal_code')} /></Field>
              {methods.length > 1 && (
                <Field label="Delivery method" className="sm:col-span-2">
                  <Controller control={form.control} name="delivery_method" render={({ field }) => (
                    <RadioGroup value={field.value} onValueChange={field.onChange} className="grid gap-2 sm:grid-cols-2">
                      {methods.map((m) => (
                        <Label key={m.code} className="flex cursor-pointer items-center gap-3 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-foreground">
                          <RadioGroupItem value={m.code} /> <span className="flex-1">{m.name}</span>
                          {Number(m.extra_charge) > 0 && <span className="text-muted-foreground">+{formatMoney(m.extra_charge)}</span>}
                        </Label>
                      ))}
                    </RadioGroup>
                  )} />
                </Field>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Payment</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Controller control={form.control} name="payment_method" render={({ field }) => (
                <RadioGroup value={field.value} onValueChange={field.onChange} className="gap-2">
                  {paymentOptions.map((o) => (
                    <Label key={o.value} className="flex cursor-pointer items-center gap-3 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-foreground">
                      <RadioGroupItem value={o.value} />
                      <span className="flex-1"><span className="block font-medium">{o.label}</span><span className="text-xs text-muted-foreground">{o.hint}</span></span>
                    </Label>
                  ))}
                </RadioGroup>
              )} />
              {requirement?.message && (
                <div className={cn('flex gap-3 rounded-lg border p-3 text-sm',
                  blocked ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900')} role="status">
                  {blocked ? <ShieldAlert className="mt-0.5 size-4 shrink-0" /> : <Info className="mt-0.5 size-4 shrink-0" />}
                  <div>
                    <p className="font-medium">{requirement.message}</p>
                    {requirement.mode === 'ADVANCE' && requirement.remaining_cod !== undefined && (
                      <p className="mt-1">You'll pay the remaining {formatMoney(requirement.remaining_cod)} on delivery. Payment options appear after you place the order.</p>
                    )}
                  </div>
                </div>
              )}
              <Field label="Order notes (optional)" htmlFor="customer_note">
                <Textarea id="customer_note" rows={2} placeholder="Delivery instructions, gift message…" {...form.register('customer_note')} />
              </Field>
            </CardContent>
          </Card>
        </div>

        <div className="lg:sticky lg:top-24 lg:h-fit">
          <Card>
            <CardHeader><CardTitle className="text-base">Order summary</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <ul className="max-h-64 space-y-3 overflow-y-auto">
                {items.map((item) => (
                  <li key={item.variantId} className="flex items-center gap-3 text-sm">
                    <div className="relative">
                      <img src={imageUrl(item.image, 100)} alt="" className="size-12 rounded-md bg-muted object-cover" />
                      <span className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-muted-foreground text-[10px] text-white">{item.quantity}</span>
                    </div>
                    <div className="min-w-0 flex-1"><p className="truncate">{item.name}</p>{item.variantTitle && <p className="text-xs text-muted-foreground">{item.variantTitle}</p>}</div>
                    <Money value={q?.lines.find((l) => l.variant_id === item.variantId)?.line_subtotal ?? item.price * item.quantity} />
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Input value={couponInput} onChange={(e) => setCouponInput(e.target.value.toUpperCase())} placeholder="Coupon code" aria-label="Coupon code" />
                <Button type="button" variant="outline" onClick={() => setCoupon(couponInput)}>Apply</Button>
              </div>
              {couponCode && q?.coupon && (
                <p className={q.coupon.valid ? 'text-xs text-emerald-700' : 'text-xs text-destructive'}>
                  {q.coupon.message} · <button type="button" className="underline" onClick={() => { setCoupon(''); setCouponInput('') }}>Remove</button>
                </p>
              )}
              <dl className="space-y-2 border-t pt-3 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd><Money value={q?.subtotal ?? 0} /></dd></div>
                {Number(q?.coupon_discount) > 0 && <div className="flex justify-between"><dt className="text-muted-foreground">Discount</dt><dd><Money value={-(q?.coupon_discount ?? 0)} /></dd></div>}
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Delivery{q?.delivery_zone ? ` · ${q.delivery_zone.name}` : ''}</dt>
                  <dd>{!watched.district ? <span className="text-muted-foreground">Choose district</span>
                    : Number(q?.delivery_charge) - Number(q?.delivery_discount) <= 0 ? 'Free' : <Money value={Number(q?.delivery_charge) - Number(q?.delivery_discount)} />}</dd>
                </div>
                <div className="flex justify-between border-t pt-2 text-base font-semibold"><dt>Total</dt><dd><Money value={q?.total ?? 0} /></dd></div>
                {requirement && requirement.amount > 0 && (
                  <>
                    <div className="flex justify-between text-amber-800"><dt>Pay now</dt><dd><Money value={requirement.amount} /></dd></div>
                    <div className="flex justify-between"><dt className="text-muted-foreground">Pay on delivery</dt><dd><Money value={Math.max(Number(q?.total ?? 0) - requirement.amount, 0)} /></dd></div>
                  </>
                )}
                {q?.delivery_zone?.estimated_days && <p className="text-xs text-muted-foreground">Estimated delivery: {q.delivery_zone.estimated_days}</p>}
              </dl>
              {stockErrors.map((e) => <p key={e.variant_id} className="text-sm text-destructive">{e.message}</p>)}
              {quote.error && <p className="text-sm text-destructive">{toUserMessage(quote.error)}</p>}
              {submitError && (
                <div className="flex gap-2 rounded-md bg-red-50 p-3 text-sm text-red-800" role="alert">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>{submitError}{submitCode === 'INSUFFICIENT_STOCK' && <> <Link to="/cart" className="underline">Update cart</Link></>}</span>
                </div>
              )}
              <Button type="submit" size="lg" className="w-full" disabled={place.isPending || blocked || stockErrors.length > 0}>
                {place.isPending ? <Spinner /> : <Lock />} Place order
              </Button>
              {blocked && config?.store.phone && <p className="text-center text-sm">Call us: <a href={`tel:${config.store.phone}`} className="underline">{config.store.phone}</a></p>}
            </CardContent>
          </Card>
        </div>
      </form>
    </div>
  )
}
