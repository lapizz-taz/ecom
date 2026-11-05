import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, ChevronDown, ChevronUp, ExternalLink, RotateCw, Route } from 'lucide-react'
import { useState } from 'react'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { type JourneyStep, type ParcelJourney, parcelJourney } from '@/services/couriers'

const dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
/** Steps shown before "Show all". */
const FIRST = 5

type Tone = 'done' | 'moving' | 'warn' | 'bad'
const TONE: Record<Tone, { text: string; dot: string; line: string }> = {
  done: { text: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500', line: 'bg-emerald-500/50' },
  moving: { text: 'text-sky-600 dark:text-sky-400', dot: 'bg-sky-500', line: 'bg-sky-500/50' },
  warn: { text: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500', line: 'bg-amber-500/50' },
  bad: { text: 'text-rose-600 dark:text-rose-400', dot: 'bg-rose-500', line: 'bg-rose-500/50' },
}

function toneOf(stage: string | null): Tone {
  const s = (stage ?? '').toLowerCase()
  if (/return|cancel|fail|reject|lost/.test(s)) return 'bad'
  if (/hold|resched|pending/.test(s)) return 'warn'
  if (/deliver|ready/.test(s)) return 'done'
  return 'moving'
}

/** Steps grouped under their stage, in order: a new heading each time the stage changes. */
function groups(steps: JourneyStep[]) {
  const out: Array<{ stage: string | null; steps: JourneyStep[] }> = []
  for (const s of steps) {
    const last = out[out.length - 1]
    if (last && (s.stage === null || s.stage === last.stage)) last.steps.push(s)
    else out.push({ stage: s.stage, steps: [s] })
  }
  return out
}

function Steps({ journey }: { journey: ParcelJourney }) {
  const [all, setAll] = useState(false)
  const shown = all ? journey.steps : journey.steps.slice(0, FIRST)
  const hidden = journey.steps.length - shown.length
  return (
    <div className="rounded-xl border bg-muted/20 p-3">
      <div className="space-y-3">
        {groups(shown).map((g, gi) => {
          const tone = TONE[toneOf(g.stage)]
          return (
            <section key={gi} className="space-y-2">
              {g.stage && (
                <div className="flex items-center gap-2">
                  <CheckCircle2 className={cn('size-4 shrink-0', tone.text)} aria-hidden />
                  <h4 className={cn('text-xs font-semibold', tone.text)}>{g.stage}</h4>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <ol>
                {g.steps.map((s, i) => {
                  const at = s.at ? new Date(s.at) : null
                  const lastInGroup = i === g.steps.length - 1
                  return (
                    <li key={i} className="grid grid-cols-[4.5rem_1rem_1fr] gap-x-2">
                      <span className="pt-0.5 text-right text-[11px] font-medium tabular-nums">
                        {at ? <>{dayFmt.format(at)} <span className="whitespace-nowrap">{timeFmt.format(at)}</span></> : ''}
                      </span>
                      <span className="relative flex justify-center">
                        <span className={cn('relative z-10 mt-1.5 size-2 rounded-full', tone.dot)} />
                        {!lastInGroup && <span className={cn('absolute top-3 bottom-0 w-px', tone.line)} />}
                      </span>
                      <div className={cn('min-w-0', !lastInGroup && 'pb-3')}>
                        <p className="text-sm leading-snug">{s.text}</p>
                        {s.note && <p className="text-xs text-muted-foreground">{s.note}</p>}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </section>
          )
        })}
      </div>
      {(hidden > 0 || all) && journey.steps.length > FIRST && (
        <Button variant="ghost" size="sm" className="mt-2 h-7 px-2 text-xs" onClick={() => setAll(!all)}>
          {all ? <><ChevronUp /> Show less</> : <><ChevronDown /> Show all ({hidden} more)</>}
        </Button>
      )}
    </div>
  )
}

function useJourney(ref: { orderId?: string; shipmentId?: string }, enabled = true) {
  const id = ref.shipmentId ?? ref.orderId ?? ''
  return useQuery({
    queryKey: ['parcel-journey', id],
    queryFn: () => parcelJourney(ref),
    enabled: enabled && !!id,
    staleTime: 60_000,
    retry: 1,
  })
}

/** The journey itself: every step from the courier, newest first. */
export function CourierJourney({ orderId, shipmentId, enabled = true }: { orderId?: string; shipmentId?: string; enabled?: boolean }) {
  const q = useJourney({ orderId, shipmentId }, enabled)
  if (q.isLoading) return <LoadingState className="py-8" />
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const j = q.data
  if (!j) return null
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {j.tracking_number && <span className="font-mono text-foreground">{j.tracking_number}</span>}
        {j.stage && <span>Now: <span className="font-medium text-foreground">{j.stage}</span></span>}
        <span className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RotateCw className={cn(q.isFetching && 'animate-spin')} /> Refresh
          </Button>
          {j.url && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
              <a href={j.url} target="_blank" rel="noreferrer">Open on {j.courier} <ExternalLink /></a>
            </Button>
          )}
        </span>
      </div>
      {j.steps.length === 0
        ? <p className="rounded-xl border bg-muted/20 p-4 text-sm text-muted-foreground">No updates from {j.courier} yet. They show here once the courier has the parcel.</p>
        : <Steps journey={j} />}
      {!j.live && j.provider !== 'manual' && j.steps.length > 0 && (
        <p className="text-xs text-muted-foreground">{j.courier}'s own tracking didn't answer, so these are the updates Fullfilio received from {j.courier}.</p>
      )}
    </div>
  )
}

/** On the order page. */
export function CourierJourneyCard({ shipmentId, courier }: { shipmentId: string; courier: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm"><Route className="size-4 text-muted-foreground" /> {courier}'s journey</CardTitle>
      </CardHeader>
      <CardContent><CourierJourney shipmentId={shipmentId} /></CardContent>
    </Card>
  )
}

/** From an order list: the journey in a side panel, read only when it opens. */
export function CourierJourneySheet({ orderId, orderNumber, courier, open, onOpenChange }: {
  orderId: string; orderNumber: string; courier: string; open: boolean; onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Clicks inside stay here: the panel opens from inside clickable order rows. */}
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-lg" onClick={(e) => e.stopPropagation()}>
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2"><Route className="size-4 text-muted-foreground" /> {courier}'s journey</SheetTitle>
          <SheetDescription>Order {orderNumber}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">{open && <CourierJourney orderId={orderId} />}</div>
      </SheetContent>
    </Sheet>
  )
}

/** A small "Journey" button that opens the panel. */
export function CourierJourneyButton({ orderId, orderNumber, courier, className }: { orderId: string; orderNumber: string; courier: string; className?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" className={cn('h-6 gap-1 px-1.5 text-[11px]', className)} title={`Where the parcel is now, step by step, from ${courier}`}
        onClick={(e) => { e.stopPropagation(); setOpen(true) }}>
        <Route className="size-3" /> Journey
      </Button>
      <CourierJourneySheet orderId={orderId} orderNumber={orderNumber} courier={courier} open={open} onOpenChange={setOpen} />
    </>
  )
}
