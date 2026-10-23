import { useMutation, useQuery } from '@tanstack/react-query'
import { CircleCheck, CircleX, Clock, Package, Phone } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { LogoMark } from '@/components/brand/logo'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { AppError, toUserMessage } from '@/lib/errors'
import { type MessageLanguage, orderReply, orderReplyView, type OrderReplyView } from '@/services/messaging'

const TEXT: Record<MessageLanguage, Record<string, string>> = {
  en: {
    loading: 'Opening your order…',
    invalid: 'This link is not valid any more. If you need help with your order, contact the shop.',
    hi: 'Hi {name}, please confirm your order',
    hiNoName: 'Please confirm your order',
    order: 'Order {number}',
    total: 'Total',
    cod: 'Pay on delivery',
    confirm: 'Confirm order',
    cancel: 'Cancel order',
    cancelAsk: 'Cancel this order?',
    cancelYes: 'Yes, cancel it',
    keep: 'Keep my order',
    confirmed: 'Thank you! Your order is confirmed',
    confirmedText: 'We will pack it and send it to you soon.',
    changed: 'Changed your mind?',
    cancelled: 'Your order is cancelled',
    cancelledText: 'Nothing will be sent. You can order again any time.',
    requested: 'We got your request to cancel',
    requestedText: 'Your order was already being prepared, so the shop will contact you about it.',
    closed: 'This order is already on its way',
    closedText: 'It can’t be changed here any more. Contact the shop if something is wrong.',
    expired: 'This link has expired',
    expiredText: 'Contact the shop if you need to change your order.',
    call: 'Call {phone}',
    more: '+{count} more',
  },
  bn: {
    loading: 'আপনার অর্ডার খোলা হচ্ছে…',
    invalid: 'এই লিংকটি আর কাজ করছে না। অর্ডার নিয়ে সাহায্য লাগলে দোকানে যোগাযোগ করুন।',
    hi: '{name}, অনুগ্রহ করে আপনার অর্ডারটি কনফার্ম করুন',
    hiNoName: 'অনুগ্রহ করে আপনার অর্ডারটি কনফার্ম করুন',
    order: 'অর্ডার {number}',
    total: 'মোট',
    cod: 'ডেলিভারিতে পরিশোধ',
    confirm: 'অর্ডার কনফার্ম',
    cancel: 'অর্ডার বাতিল',
    cancelAsk: 'অর্ডারটি বাতিল করবেন?',
    cancelYes: 'হ্যাঁ, বাতিল করুন',
    keep: 'অর্ডার রাখুন',
    confirmed: 'ধন্যবাদ! আপনার অর্ডার কনফার্ম হয়েছে',
    confirmedText: 'আমরা শিগগিরই প্যাক করে পাঠিয়ে দেব।',
    changed: 'মত বদলেছেন?',
    cancelled: 'আপনার অর্ডার বাতিল হয়েছে',
    cancelledText: 'কিছু পাঠানো হবে না। যেকোনো সময় আবার অর্ডার করতে পারেন।',
    requested: 'বাতিলের অনুরোধ পেয়েছি',
    requestedText: 'অর্ডারটি আগেই প্রস্তুত হচ্ছিল, তাই দোকান থেকে আপনার সাথে যোগাযোগ করা হবে।',
    closed: 'এই অর্ডারটি ইতিমধ্যে পাঠানো হয়েছে',
    closedText: 'এখান থেকে আর বদলানো যাবে না। কোনো সমস্যা হলে দোকানে যোগাযোগ করুন।',
    expired: 'এই লিংকের মেয়াদ শেষ',
    expiredText: 'অর্ডার বদলাতে চাইলে দোকানে যোগাযোগ করুন।',
    call: 'কল করুন {phone}',
    more: 'আরও {count}টি',
  },
}
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ''))
const money = (symbol: string, n: number | null | undefined) => `${symbol}${Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`

/**
 * The page behind an order confirmation's "Confirm your order" (no sign-in: the link is the key).
 * Opening it changes nothing; the customer's tap on Confirm or Cancel does.
 */
export default function OrderConfirmPage() {
  const { merchant = '', token = '' } = useParams()
  const [params] = useSearchParams()
  const [asking, setAsking] = useState(params.get('action') === 'cancel')
  const view = useQuery({ queryKey: ['order-reply', merchant, token], queryFn: () => orderReplyView(merchant, token), retry: false, staleTime: Infinity })
  const [answer, setAnswer] = useState<OrderReplyView | null>(null)
  const reply = useMutation({
    meta: { silent: true },
    mutationFn: (r: 'confirm' | 'cancel') => orderReply(merchant, token, r),
    onSuccess: (v) => { setAnswer(v); setAsking(false) },
  })
  const v = answer ?? view.data
  const t = TEXT[v?.language ?? (document.documentElement.lang === 'bn' ? 'bn' : 'en')]

  return (
    <main lang={v?.language ?? 'en'} className="flex min-h-dvh flex-col items-center bg-muted/40 px-4 py-8 sm:py-14">
      <div className="w-full max-w-md">
        {view.isLoading ? (
          <p className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground"><Spinner /> {t.loading}</p>
        ) : !v ? (
          <Card>
            <div className="px-5 py-6">
              {/* A link that names no order is "not valid"; anything else (no connection) can be tried again. */}
              <State icon={<CircleX />} tone="muted" title={view.error instanceof AppError && view.error.code === 'NETWORK' ? toUserMessage(view.error) : t.invalid} />
            </div>
          </Card>
        ) : (
          <Card>
            <header className="flex items-center gap-3 border-b px-5 py-4">
              {v.store.logo_url
                ? <img src={v.store.logo_url} alt="" className="size-9 rounded-md object-contain" />
                : <span className="flex size-9 items-center justify-center rounded-md text-sm font-semibold text-white" style={{ background: v.store.accent_color }}>{v.store.name.slice(0, 1).toUpperCase()}</span>}
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{v.store.name}</span>
                <span className="block text-xs text-muted-foreground">{fill(t.order, { number: v.order.number })}</span>
              </span>
            </header>

            <div className="space-y-5 px-5 py-5">
              <Body view={v} t={t} />
              <Items view={v} t={t} />

              {reply.error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{toUserMessage(reply.error)}</p>}

              {asking && v.can_cancel ? (
                <div className="space-y-2 rounded-lg border p-3">
                  <p className="text-sm font-medium">{t.cancelAsk}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="outline" disabled={reply.isPending} onClick={() => setAsking(false)}>{t.keep}</Button>
                    <Button variant="destructive" disabled={reply.isPending} onClick={() => reply.mutate('cancel')}>
                      {reply.isPending && reply.variables === 'cancel' ? <Spinner /> : null} {t.cancelYes}
                    </Button>
                  </div>
                </div>
              ) : v.can_confirm ? (
                <div className="space-y-2">
                  <Button className="h-11 w-full text-white hover:opacity-90" style={{ background: v.store.accent_color }} disabled={reply.isPending}
                    onClick={() => reply.mutate('confirm')}>
                    {reply.isPending && reply.variables === 'confirm' ? <Spinner /> : <CircleCheck />} {t.confirm}
                  </Button>
                  {v.can_cancel && <Button variant="ghost" className="w-full text-muted-foreground" disabled={reply.isPending} onClick={() => setAsking(true)}>{t.cancel}</Button>}
                </div>
              ) : v.can_cancel ? (
                <p className="text-center text-sm text-muted-foreground">
                  {t.changed} <button type="button" className="font-medium text-foreground underline" onClick={() => setAsking(true)}>{t.cancel}</button>
                </p>
              ) : null}

              {v.store.phone && !v.can_confirm && (
                <a href={`tel:${v.store.phone}`} className="flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground">
                  <Phone className="size-4" /> {fill(t.call, { phone: v.store.phone })}
                </a>
              )}
            </div>
          </Card>
        )}
        <a href="/" className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-foreground hover:text-foreground">
          <LogoMark className="size-4" /> Powered by Fullfilio
        </a>
      </div>
    </main>
  )
}

function Body({ view: v, t }: { view: OrderReplyView; t: Record<string, string> }) {
  switch (v.state) {
    case 'OPEN':
      return <h1 className="text-lg font-semibold tracking-tight text-balance">{v.order.customer_first_name ? fill(t.hi, { name: v.order.customer_first_name }) : t.hiNoName}</h1>
    case 'CONFIRMED': return <State icon={<CircleCheck />} tone="ok" title={t.confirmed} text={t.confirmedText} />
    case 'CANCELLED': return <State icon={<CircleX />} tone="muted" title={t.cancelled} text={t.cancelledText} />
    case 'CANCEL_REQUESTED': return <State icon={<Clock />} tone="warn" title={t.requested} text={t.requestedText} />
    case 'CLOSED': return <State icon={<Package />} tone="muted" title={t.closed} text={t.closedText} />
    default: return <State icon={<Clock />} tone="muted" title={t.expired} text={t.expiredText} />
  }
}

function Items({ view: v, t }: { view: OrderReplyView; t: Record<string, string> }) {
  const shown = v.order.items.slice(0, 5)
  const cod = Number(v.order.cod_amount ?? 0)
  return (
    <div className="rounded-lg border">
      <ul className="divide-y">
        {shown.map((i, n) => (
          <li key={n} className="flex items-center gap-3 px-3 py-2.5">
            {i.image_url
              ? <img src={i.image_url} alt="" className="size-11 shrink-0 rounded-md border object-cover" />
              : <span className="flex size-11 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"><Package className="size-4" /></span>}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{i.title}</span>
              {i.variant && <span className="block truncate text-xs text-muted-foreground">{i.variant}</span>}
            </span>
            <span className="text-sm tabular-nums text-muted-foreground">×{i.quantity}</span>
          </li>
        ))}
        {v.order.items.length > shown.length && <li className="px-3 py-2 text-xs text-muted-foreground">{fill(t.more, { count: v.order.items.length - shown.length })}</li>}
      </ul>
      <dl className="space-y-1 border-t bg-muted/30 px-3 py-2.5 text-sm">
        <div className="flex justify-between"><dt className="text-muted-foreground">{t.total}</dt><dd className="font-semibold tabular-nums">{money(v.store.currency_symbol, v.order.total)}</dd></div>
        {cod > 0 && cod !== Number(v.order.total) && (
          <div className="flex justify-between"><dt className="text-muted-foreground">{t.cod}</dt><dd className="tabular-nums">{money(v.store.currency_symbol, cod)}</dd></div>
        )}
      </dl>
    </div>
  )
}

function Card({ children }: { children: ReactNode }) {
  return <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">{children}</section>
}

function State({ icon, tone, title, text }: { icon: ReactNode; tone: 'ok' | 'warn' | 'muted'; title: string; text?: string }) {
  const color = tone === 'ok' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : 'text-muted-foreground'
  return (
    <div className="flex flex-col items-center px-2 py-2 text-center">
      <span className={`[&_svg]:size-9 ${color}`}>{icon}</span>
      <h1 className="mt-3 text-lg font-semibold tracking-tight text-balance">{title}</h1>
      {text && <p className="mt-1 text-sm text-muted-foreground">{text}</p>}
    </div>
  )
}
