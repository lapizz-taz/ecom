import { useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatMoney, formatNumber, toNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { EstimatedProfit } from '@/services/reports'

type Lang = 'en' | 'bn'
type Line = 'sales' | 'other_income' | 'return_charges' | 'product_cost' | 'courier_cost' | 'ads' | 'other_expense' | 'profit'

const TEXT = {
  en: {
    help: 'Help',
    title: 'Profit',
    intro: 'An order counts from the day it is approved. Profit takes the sales of the approved orders, adds other income and the return charges customers paid, then takes off product cost, courier cost, ads and other expenses.',
    calculation: 'Calculation',
    formula: 'Sales + Other income + Return charges paid − Product cost − Courier cost − Ads − Other expense = Profit',
    lines: {
      sales: 'Sales (approved orders)', other_income: 'Other income', return_charges: 'Return charges paid', product_cost: 'Product cost',
      courier_cost: 'Courier cost', ads: 'Ads', other_expense: 'Other expense', profit: 'Profit',
    } satisfies Record<Line, string>,
    points: [
      ['What this shows', 'The money the business is left with from the orders approved in these days, after every cost, ads included.'],
      ['Returns', 'A returned order has no sale and no product cost: the goods come back. The courier’s delivery and return charges are a loss, unless the customer paid them (an advance): then there is no loss.'],
      ['Until delivery', 'An order on its way counts in full until it is delivered or comes back. Before a parcel is booked, its delivery charge stands in for the courier’s fee.'],
      ['The books', 'Finance → Profit & loss counts a sale only once it is delivered, so it shows a different number while orders are on their way.'],
    ],
    returns: (n: number, cost: string, paid: string, loss: string) => `${n} returned: courier charges ${cost}, paid by customers ${paid}, loss ${loss}.`,
    orders: (o: EstimatedProfit['orders']) => `Approved orders: ${formatNumber(o.approved)} · delivered ${formatNumber(o.delivered)} · in progress ${formatNumber(o.open)} · returned ${formatNumber(o.returned)} · cancelled ${formatNumber(o.cancelled)}`,
    missingCost: (n: number) => `${n} order${n === 1 ? ' has' : 's have'} products without a cost, so the profit is too high. Add the cost on the product.`,
    estimated: (n: number) => `The courier cost of ${n} order${n === 1 ? ' is' : 's is'} an estimate until the courier reports it.`,
    books: 'Profit & loss (delivered)',
    orderList: 'See the orders',
  },
  bn: {
    help: 'সাহায্য',
    title: 'লাভ',
    intro: 'অর্ডার অ্যাপ্রুভ হওয়ার দিন থেকেই লাভে ধরা হয়। অ্যাপ্রুভ হওয়া অর্ডারের বিক্রি, অন্যান্য আয় আর গ্রাহকের দেওয়া রিটার্ন চার্জ যোগ করে, তারপর পণ্যের খরচ, কুরিয়ার খরচ, বিজ্ঞাপন ও অন্যান্য খরচ বাদ দেওয়া হয়।',
    calculation: 'হিসাব',
    formula: 'বিক্রি + অন্যান্য আয় + পরিশোধিত রিটার্ন চার্জ − পণ্যের খরচ − কুরিয়ার খরচ − বিজ্ঞাপন − অন্যান্য খরচ = লাভ',
    lines: {
      sales: 'বিক্রি (অ্যাপ্রুভড অর্ডার)', other_income: 'অন্যান্য আয়', return_charges: 'পরিশোধিত রিটার্ন চার্জ', product_cost: 'পণ্যের খরচ',
      courier_cost: 'কুরিয়ার খরচ', ads: 'বিজ্ঞাপন', other_expense: 'অন্যান্য খরচ', profit: 'লাভ',
    } satisfies Record<Line, string>,
    points: [
      ['এটা কী দেখায়', 'এই দিনগুলোতে অ্যাপ্রুভ হওয়া অর্ডার থেকে সব খরচ (বিজ্ঞাপনসহ) বাদ দিয়ে ব্যবসার হাতে যে টাকা থাকে।'],
      ['রিটার্ন', 'রিটার্ন হওয়া অর্ডারে বিক্রি আর পণ্যের খরচ ধরা হয় না, কারণ পণ্য ফেরত আসে। কুরিয়ারের ডেলিভারি ও রিটার্ন চার্জ লোকসান, তবে গ্রাহক তা আগেই দিয়ে থাকলে (অগ্রিম) কোনো লোকসান নেই।'],
      ['ডেলিভারির আগ পর্যন্ত', 'পথে থাকা অর্ডার ডেলিভারি বা রিটার্ন না হওয়া পর্যন্ত পুরোটা ধরা হয়। পার্সেল বুক করার আগে কুরিয়ার খরচ হিসেবে ডেলিভারি চার্জ ধরা হয়।'],
      ['হিসাবের খাতা', 'Finance → Profit & loss শুধু ডেলিভারি হলে বিক্রি ধরে, তাই অর্ডার পথে থাকলে সেখানে আলাদা সংখ্যা দেখায়।'],
    ],
    returns: (n: number, cost: string, paid: string, loss: string) => `${n}টি রিটার্ন: কুরিয়ার চার্জ ${cost}, গ্রাহক দিয়েছেন ${paid}, লোকসান ${loss}।`,
    orders: (o: EstimatedProfit['orders']) => `অ্যাপ্রুভড অর্ডার: ${formatNumber(o.approved)} · ডেলিভারড ${formatNumber(o.delivered)} · চলমান ${formatNumber(o.open)} · রিটার্ন ${formatNumber(o.returned)} · বাতিল ${formatNumber(o.cancelled)}`,
    missingCost: (n: number) => `${n}টি অর্ডারের পণ্যে খরচ দেওয়া নেই, তাই লাভ বেশি দেখাচ্ছে। পণ্যে খরচ যোগ করুন।`,
    estimated: (n: number) => `${n}টি অর্ডারের কুরিয়ার খরচ আনুমানিক, কুরিয়ার জানালে ঠিক হবে।`,
    books: 'হিসাবের খাতা',
    orderList: 'অর্ডারগুলো দেখুন',
  },
}

const ADD: Line[] = ['sales', 'other_income', 'return_charges']
const TAKE: Line[] = ['product_cost', 'courier_cost', 'ads', 'other_expense']

function readLang(): Lang {
  try { return localStorage.getItem('fullfilio.profit-help.lang') === 'bn' ? 'bn' : 'en' } catch { return 'en' }
}

/** How the dashboard's profit is made: approved orders, returns with the charges customers paid, ads and expenses. */
export function EstimatedProfitDialog({ open, onOpenChange, estimate }: { open: boolean; onOpenChange: (open: boolean) => void; estimate: EstimatedProfit | null | undefined }) {
  const [lang, setLang] = useState<Lang>(readLang)
  const pick = (l: Lang) => {
    setLang(l)
    try { localStorage.setItem('fullfilio.profit-help.lang', l) } catch { /* private mode */ }
  }
  const x = TEXT[lang]
  const t = estimate?.totals
  const amount = (k: Line) => toNumber(t?.[k])
  const profit = amount('profit')
  const returns = estimate?.returns
  const quality = estimate?.quality

  // Each amount carries its sign, so the boxes can wrap at any width.
  const box = (k: Line, sign: string) => (
    <div key={k} className={cn('flex min-w-0 flex-col justify-between rounded-lg border bg-background px-3 py-2', k === 'profit' && 'border-brand/40 bg-brand-soft')}>
      <p className={cn('text-xs leading-tight text-muted-foreground', k === 'profit' && 'text-brand')}>{x.lines[k]}</p>
      <p className={cn('mt-0.5 font-semibold tabular-nums', k === 'profit' && cn('text-lg', profit < 0 ? 'text-red-600' : 'text-emerald-600'))}>
        {sign && <span aria-hidden className="mr-1 font-normal text-muted-foreground">{sign}</span>}{formatMoney(amount(k))}
      </p>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader className="pr-8">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs text-muted-foreground">{x.help}</p>
              <DialogTitle>{x.title}</DialogTitle>
            </div>
            <div role="group" aria-label="Language" className="flex shrink-0 rounded-lg border p-0.5 text-xs">
              {(['bn', 'en'] as const).map((l) => (
                <button key={l} type="button" aria-pressed={lang === l} onClick={() => pick(l)}
                  className={cn('rounded-md px-2 py-0.5 transition-colors', lang === l ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
                  {l === 'bn' ? 'বাংলা' : 'English'}
                </button>
              ))}
            </div>
          </div>
          <DialogDescription>{x.intro}</DialogDescription>
        </DialogHeader>

        <section className="grid gap-3 rounded-xl border bg-muted/40 p-3">
          <div>
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{x.calculation}</p>
            <p className="mt-1 text-sm font-medium">{x.formula}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{ADD.map((k, i) => box(k, i ? '+' : ''))}</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{TAKE.map((k) => box(k, '−'))}</div>
          {box('profit', '=')}
        </section>

        <ol className="grid gap-2 text-sm">
          {x.points.map(([head, body], i) => (
            <li key={head}>
              <span className="font-semibold">{i + 1}. {head}</span> — <span className="text-muted-foreground">{body}</span>
              {i === 1 && returns && returns.orders > 0 && (
                <span className="mt-0.5 block font-medium">
                  {x.returns(returns.orders, formatMoney(returns.courier_cost), formatMoney(returns.paid), formatMoney(returns.loss))}
                </span>
              )}
            </li>
          ))}
        </ol>

        {estimate && (
          <div className="grid gap-1 text-xs text-muted-foreground">
            <p>{x.orders(estimate.orders)}</p>
            {quality && quality.missing_cost > 0 && <p className="text-amber-600">{x.missingCost(quality.missing_cost)}</p>}
            {quality && quality.courier_estimated > 0 && <p>{x.estimated(quality.courier_estimated)}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" asChild><Link to="/admin/finance/profit-loss">{x.books}</Link></Button>
          <Button size="sm" asChild><Link to="/admin/orders/approved">{x.orderList}</Link></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
