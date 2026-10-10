import { useMutation, useQuery } from '@tanstack/react-query'
import { Phone, PhoneCall } from 'lucide-react'
import { createContext, useContext, type ReactNode } from 'react'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { CALL_STATUS, OUTCOMES, pbxCallState, type OrderCallState } from '@/services/voicedrive'
import { usePhone } from './phone-context'

const StatesContext = createContext<Record<string, OrderCallState>>({})

/** Loads the call state of the orders on screen in one request (for list badges). */
export function OrderCallStatesProvider({ orderIds, children }: { orderIds: string[]; children: ReactNode }) {
  const { canCall } = usePhone()
  const ids = [...orderIds].sort()
  const q = useQuery({
    queryKey: ['vd-order-call-states', ids],
    queryFn: () => pbxCallState.getOrderCallStates(ids),
    enabled: canCall && ids.length > 0,
    staleTime: 10_000,
    refetchInterval: 20_000,
  })
  return <StatesContext.Provider value={q.data ?? {}}>{children}</StatesContext.Provider>
}

const outcomeLabel = Object.fromEntries(OUTCOMES.map((o) => [o.value, o.label]))

/** "Called 2× · No answer" under the phone number. */
export function OrderCallBadge({ orderId }: { orderId: string }) {
  const s = useContext(StatesContext)[orderId]
  if (!s) return null
  const text = s.live ? 'On a call now' : `Called ${s.attempts}× · ${s.lastOutcome ? outcomeLabel[s.lastOutcome] : CALL_STATUS[s.lastStatus]?.label ?? s.lastStatus}`
  return (
    <span className={cn('flex w-fit items-center gap-1 rounded px-1 text-[11px] whitespace-nowrap', s.live ? 'bg-emerald-50 text-emerald-700' : s.answered ? 'text-emerald-700' : 'text-amber-700')}
      title={`Last call ${new Date(s.lastAt).toLocaleString()}`}>
      <PhoneCall className="size-3" /> {text}
    </span>
  )
}

/** Calls the order's customer through VoiceDrive when available, else a phone link. */
export function OrderCallLink({ orderId, phone, name, kind, className, children }: {
  orderId: string
  phone: string
  name: string
  kind: 'APPROVED_ORDER' | 'WEB_ORDER'
  className?: string
  children?: ReactNode
}) {
  const { canCall, dial } = usePhone()
  const call = useMutation({ mutationFn: () => dial({ phone, orderId, kind }), onError: (e) => toast.error((e as Error).message) })
  const content = children ?? <Phone className="size-3.5" />
  if (!canCall) return <a href={`tel:${phone}`} className={className} aria-label={`Call ${name}`}>{content}</a>
  return (
    <button type="button" className={cn(className, call.isPending && 'animate-pulse')} disabled={call.isPending} aria-label={`Call ${name} with VoiceDrive`}
      onClick={(e) => { e.stopPropagation(); call.mutate() }}>
      {content}
    </button>
  )
}
