import { useMutation, useQuery } from '@tanstack/react-query'
import { CircleX, MailCheck, MailX } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useParams } from 'react-router'
import { LogoMark } from '@/components/brand/logo'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { AppError, toUserMessage } from '@/lib/errors'
import { type MessageLanguage, unsubscribe, unsubscribeView, type UnsubscribeView } from '@/services/messaging'

const TEXT: Record<MessageLanguage, Record<string, string>> = {
  en: {
    loading: 'Opening…',
    invalid: 'This link is not valid any more. If you still get emails you don’t want, reply to one and ask the shop to stop.',
    ask: 'Stop offer emails from {store}?',
    askText: 'You won’t get cart reminders or review requests at {email} any more.',
    keeps: 'Emails about your orders (confirmation, shipping, delivery) still come.',
    unsubscribe: 'Unsubscribe',
    done: 'You are unsubscribed',
    doneText: '{email} won’t get cart reminders or review requests from {store} any more.',
    again: 'Unsubscribed by mistake?',
    subscribe: 'Subscribe again',
    back: 'You are subscribed again',
    backText: 'You’ll get {store}’s cart reminders and review requests at {email} again.',
    visit: 'Visit {store}',
  },
  bn: {
    loading: 'খোলা হচ্ছে…',
    invalid: 'এই লিংকটি আর কাজ করছে না। অপ্রয়োজনীয় ইমেইল এখনো এলে, সেই ইমেইলের উত্তরে দোকানকে বন্ধ করতে বলুন।',
    ask: '{store} থেকে অফারের ইমেইল বন্ধ করবেন?',
    askText: '{email} ঠিকানায় কার্ট রিমাইন্ডার বা রিভিউয়ের অনুরোধ আর আসবে না।',
    keeps: 'আপনার অর্ডারের ইমেইল (কনফার্মেশন, শিপিং, ডেলিভারি) আগের মতোই আসবে।',
    unsubscribe: 'আনসাবস্ক্রাইব করুন',
    done: 'আনসাবস্ক্রাইব হয়েছে',
    doneText: '{email} ঠিকানায় {store} থেকে কার্ট রিমাইন্ডার বা রিভিউয়ের অনুরোধ আর আসবে না।',
    again: 'ভুল করে আনসাবস্ক্রাইব করেছেন?',
    subscribe: 'আবার সাবস্ক্রাইব করুন',
    back: 'আবার সাবস্ক্রাইব হয়েছে',
    backText: '{email} ঠিকানায় {store} থেকে কার্ট রিমাইন্ডার ও রিভিউয়ের অনুরোধ আবার আসবে।',
    visit: '{store} দেখুন',
  },
}
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? '')

/**
 * The page behind "Unsubscribe" in a cart reminder or review request (no sign-in: the link is the key).
 * Opening it changes nothing (mail scanners open links); the customer's tap does. A mail app's own
 * Unsubscribe button works without this page (one-click, see the messaging function).
 */
export default function UnsubscribePage() {
  const { merchant = '', token = '' } = useParams()
  const view = useQuery({ queryKey: ['unsubscribe', merchant, token], queryFn: () => unsubscribeView(merchant, token), retry: false, staleTime: Infinity })
  const [answer, setAnswer] = useState<{ view: UnsubscribeView; subscribed: boolean } | null>(null)
  const change = useMutation({
    meta: { silent: true },
    mutationFn: (subscribe: boolean) => unsubscribe(merchant, token, subscribe),
    onSuccess: (v, subscribe) => setAnswer({ view: v, subscribed: subscribe }),
  })
  const v = answer?.view ?? view.data
  const lang = v?.language ?? (document.documentElement.lang === 'bn' ? 'bn' : 'en')
  const t = TEXT[lang]
  const vars = { store: v?.store.name ?? '', email: v?.email ?? '' }

  return (
    <main lang={lang} className="flex min-h-dvh flex-col items-center bg-muted/40 px-4 py-8 sm:py-14">
      <div className="w-full max-w-md">
        {view.isLoading ? (
          <p className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground"><Spinner /> {t.loading}</p>
        ) : !v ? (
          <Card>
            <div className="px-5 py-6">
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
                <span className="block truncate text-xs text-muted-foreground">{v.email}</span>
              </span>
            </header>

            <div className="space-y-5 px-5 py-5">
              {v.unsubscribed ? (
                <State icon={<MailX />} tone="muted" title={t.done} text={fill(t.doneText, vars)} />
              ) : answer?.subscribed ? (
                <State icon={<MailCheck />} tone="ok" title={t.back} text={fill(t.backText, vars)} />
              ) : (
                <div className="space-y-1.5">
                  <h1 className="text-lg font-semibold tracking-tight text-balance">{fill(t.ask, vars)}</h1>
                  <p className="text-sm text-muted-foreground">{fill(t.askText, vars)}</p>
                </div>
              )}

              <p className="rounded-lg border bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">{t.keeps}</p>

              {change.error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{toUserMessage(change.error)}</p>}

              {v.unsubscribed ? (
                <p className="text-center text-sm text-muted-foreground">
                  {t.again}{' '}
                  <button type="button" className="inline-flex items-center gap-1 font-medium text-foreground underline disabled:opacity-60" disabled={change.isPending} onClick={() => change.mutate(true)}>
                    {change.isPending && <Spinner />} {t.subscribe}
                  </button>
                </p>
              ) : !answer?.subscribed && (
                <Button className="h-11 w-full text-white hover:opacity-90" style={{ background: v.store.accent_color }} disabled={change.isPending} onClick={() => change.mutate(false)}>
                  {change.isPending ? <Spinner /> : <MailX />} {t.unsubscribe}
                </Button>
              )}

              {v.store.url && (
                <a href={v.store.url} className="block text-center text-sm text-muted-foreground hover:text-foreground">{fill(t.visit, vars)}</a>
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

function Card({ children }: { children: ReactNode }) {
  return <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">{children}</section>
}

function State({ icon, tone, title, text }: { icon: ReactNode; tone: 'ok' | 'muted'; title: string; text?: string }) {
  return (
    <div className="flex flex-col items-center px-2 py-2 text-center">
      <span className={`[&_svg]:size-9 ${tone === 'ok' ? 'text-emerald-600' : 'text-muted-foreground'}`}>{icon}</span>
      <h1 className="mt-3 text-lg font-semibold tracking-tight text-balance">{title}</h1>
      {text && <p className="mt-1 text-sm text-muted-foreground">{text}</p>}
    </div>
  )
}
