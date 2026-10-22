import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, BellRing, Clock, FileText, Loader2, PackageCheck, ShoppingBag, Tag, UserRound, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { toUserMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { inboxUpdate, type InboxThread, orderMessage, setFollowUp, setReminder } from '@/services/inbox'
import { windowLeft } from './ui'

const QUICK_LABELS = ['Order', 'Price ask', 'Complaint', 'Return-exchange', 'VIP', 'Wholesale']
const FOLLOW_UP_DELAYS = [[30, '30 min'], [60, '1 hour'], [180, '3 hours'], [360, '6 hours'], [720, '12 hours'], [1200, '20 hours']] as const
const FOLLOW_UP_TEXT = 'Hi! Just checking in. Would you like to place the order? Reply here and we will help you right away.'

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** One row above the message box: order status, invoice, follow-up, then order draft, tags, customer, task, and the 24-hour timer. */
export function ChatActions({ data, onInsert, onOrderDraft, onTogglePanel }: {
  data: InboxThread
  onInsert: (text: string) => void
  onOrderDraft: () => void
  onTogglePanel: () => void
}) {
  const qc = useQueryClient()
  const { can } = useAuth()
  const c = data.conversation
  const order = data.orders.find((o) => o.linked) ?? data.orders[0]
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['inbox-thread', c.id] })
    void qc.invalidateQueries({ queryKey: ['inbox-list'] })
  }
  const onError = (e: unknown) => toast.error(toUserMessage(e))
  const write = useMutation({ mutationFn: (kind: 'STATUS' | 'INVOICE') => orderMessage(order!.id, kind), onSuccess: onInsert, onError })
  const cancelFollowUp = useMutation({ mutationFn: () => setFollowUp(c.id, null), onSuccess: () => { toast.success('Follow-up cancelled'); refresh() }, onError })
  const win = windowLeft(c.last_customer_message_at)
  const chip = 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium whitespace-nowrap transition-colors hover:bg-muted disabled:opacity-40'
  const icon = 'inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-3.5'

  return (
    <div className="border-t bg-background px-2 pt-2 sm:px-3">
      <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
        {c.kind === 'MESSAGE' && (
          <>
            {/* An order's status and invoice are for staff who may see orders. */}
            {can('orders.view') && (
              <>
                <button type="button" className={chip} disabled={!order || write.isPending} onClick={() => write.mutate('STATUS')} title={order ? `Order ${order.order_number}` : 'No order yet'}>
                  {write.isPending && write.variables === 'STATUS' ? <Loader2 className="size-3.5 animate-spin" /> : <PackageCheck className="size-3.5" />} Status
                </button>
                <button type="button" className={chip} disabled={!order || write.isPending} onClick={() => write.mutate('INVOICE')} title={order ? `Order ${order.order_number}` : 'No order yet'}>
                  {write.isPending && write.variables === 'INVOICE' ? <Loader2 className="size-3.5 animate-spin" /> : <FileText className="size-3.5" />} Invoice
                </button>
              </>
            )}
            <FollowUpPopover id={c.id} minutesLeft={win.minutes} onDone={refresh} disabled={!win.open} className={chip} />
            <span className="mx-0.5 h-4 w-px shrink-0 bg-border" />
          </>
        )}
        <button type="button" className={icon} onClick={onOrderDraft} title="Order draft" aria-label="Order draft"><ShoppingBag /></button>
        <TagsPopover labels={c.labels} id={c.id} onDone={refresh} className={icon} />
        <button type="button" className={cn(icon, 'xl:hidden')} onClick={onTogglePanel} title="Customer" aria-label="Customer"><UserRound /></button>
        <TaskPopover id={c.id} current={c.remind_at} onDone={refresh} className={icon} />
        {c.kind === 'MESSAGE' && (
          <span className={cn('ml-auto inline-flex shrink-0 items-center gap-1 pl-2 text-[11px] whitespace-nowrap tabular-nums',
            win.open ? (win.minutes < 120 ? 'text-amber-600' : 'text-muted-foreground') : 'text-red-500')}
            title="Meta allows normal replies for 24 hours after the customer's last message">
            <Clock className="size-3" /> {win.label}
          </span>
        )}
      </div>
      {(c.auto_follow_up_at || c.remind_at) && (
        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px]">
          {c.auto_follow_up_at && (
            <span className="inline-flex items-center gap-1 text-violet-600 dark:text-violet-400">
              <AlarmClock className="size-3" /> Follow-up {clock(c.auto_follow_up_at)}
              <button type="button" className="underline-offset-2 hover:underline" onClick={() => cancelFollowUp.mutate()} aria-label="Cancel follow-up"><X className="size-3" /></button>
            </span>
          )}
          {c.remind_at && (
            <span className="inline-flex items-center gap-1 text-amber-600"><BellRing className="size-3" /> {new Date(c.remind_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}{c.remind_note ? ` · ${c.remind_note}` : ''}</span>
          )}
        </div>
      )}
    </div>
  )
}

function FollowUpPopover({ id, minutesLeft, onDone, disabled, className }: { id: string; minutesLeft: number; onDone: () => void; disabled: boolean; className: string }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(FOLLOW_UP_TEXT)
  const options = FOLLOW_UP_DELAYS.filter(([m]) => m < minutesLeft - 5)
  const [minutes, setMinutes] = useState<number>(180)
  const save = useMutation({
    mutationFn: () => setFollowUp(id, minutes, text),
    onSuccess: () => { toast.success('Follow-up scheduled'); setOpen(false); onDone() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" disabled={disabled} className={className} title={disabled ? 'The 24-hour window is closed' : 'Send a follow-up by itself if they do not answer'}>
          <AlarmClock className="size-3.5" /> Follow up
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3" align="start">
        <p className="text-sm font-medium">Send by itself if they don’t answer</p>
        <div className="flex flex-wrap gap-1">
          {options.map(([m, l]) => (
            <button key={m} type="button" onClick={() => setMinutes(m)}
              className={cn('rounded-full border px-2.5 py-0.5 text-xs', minutes === m ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground')}>{l}</button>
          ))}
          {!options.length && <p className="text-xs text-muted-foreground">Too little of the 24-hour window is left.</p>}
        </div>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} />
        <p className="text-[11px] text-muted-foreground">Cancelled as soon as the customer writes. Sent only inside Meta’s 24-hour window.</p>
        <Button size="sm" className="w-full" disabled={!options.some(([m]) => m === minutes) || !text.trim() || save.isPending} onClick={() => save.mutate()}>Schedule follow-up</Button>
      </PopoverContent>
    </Popover>
  )
}

function TagsPopover({ id, labels, onDone, className }: { id: string; labels: string[]; onDone: () => void; className: string }) {
  const [value, setValue] = useState('')
  const save = useMutation({ mutationFn: (next: string[]) => inboxUpdate(id, { labels: next }), onSuccess: onDone, onError: (e) => toast.error(toUserMessage(e)) })
  const toggle = (l: string) => save.mutate(labels.includes(l) ? labels.filter((x) => x !== l) : [...labels, l])
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn(className, labels.length > 0 && 'text-violet-600')} title="Tags" aria-label="Tags"><Tag /></button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-2" align="start">
        <div className="flex flex-wrap gap-1">
          {[...new Set([...QUICK_LABELS, ...labels])].map((l) => (
            <button key={l} type="button" onClick={() => toggle(l)}
              className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs', labels.includes(l) ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground')}>
              {l}{labels.includes(l) && <X className="size-3" />}
            </button>
          ))}
        </div>
        <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (value.trim()) { save.mutate([...new Set([...labels, value.trim()])]); setValue('') } }}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="New tag" className="h-8 text-sm" maxLength={40} />
          <Button size="sm" type="submit" variant="outline">Add</Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}

function TaskPopover({ id, current, onDone, className }: { id: string; current: string | null; onDone: () => void; className: string }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const save = useMutation({
    mutationFn: (at: Date | null) => setReminder(id, at ? at.toISOString() : null, note),
    onSuccess: (_r, at) => { toast.success(at ? 'Reminder set: it is in the Follow-up tab' : 'Reminder cleared'); setOpen(false); setNote(''); onDone() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const inHours = (h: number) => new Date(Date.now() + h * 3600_000)
  const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn(className, current && 'text-amber-600')} title="Remind the team" aria-label="Task"><BellRing /></button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-2" align="start">
        <p className="text-sm font-medium">Remind the team</p>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Call back about the size" className="h-8 text-sm" maxLength={300} />
        <div className="grid grid-cols-3 gap-1">
          <Button size="sm" variant="outline" onClick={() => save.mutate(inHours(1))}>1 hour</Button>
          <Button size="sm" variant="outline" onClick={() => save.mutate(inHours(3))}>3 hours</Button>
          <Button size="sm" variant="outline" onClick={() => save.mutate(tomorrow())}>Tomorrow</Button>
        </div>
        {current && <Button size="sm" variant="ghost" className="w-full" onClick={() => save.mutate(null)}>Clear reminder</Button>}
      </PopoverContent>
    </Popover>
  )
}
