import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Link2, MapPin, MessageSquareText, Phone, Plus, Search, ShoppingBag, StickyNote, Tag, Trash2, UserRound, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Money } from '@/components/common/money'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { toUserMessage } from '@/lib/errors'
import { formatDate, formatMoney, timeAgo } from '@/lib/format'
import { ORDER_STATUS } from '@/lib/status'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useDebounce } from '@/hooks/use-debounce'
import { findCustomersToLink, findOrdersToLink, inboxNoteAdd, inboxNoteDelete, inboxThread, inboxUpdate } from '@/services/inbox'
import type { OrderStatus } from '@/types/domain'
import { ChatAvatar, chatTime, PLATFORM, PlatformIcon } from './ui'

export function CustomerPanel({ id, onDraft, onOpen, onClose, onOrderDraft }: {
  id: string; onDraft: (text: string) => void; onOpen: (id: string) => void; onClose?: () => void; onOrderDraft?: () => void
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { can } = useAuth()
  const thread = useQuery({ queryKey: ['inbox-thread', id], queryFn: () => inboxThread(id), refetchInterval: 5_000 })
  const c = thread.data?.conversation
  const [form, setForm] = useState({ name: '', phone: '', address: '' })
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  useEffect(() => {
    if (c) setForm({ name: c.customer_name ?? '', phone: c.customer_phone ?? '', address: c.customer_address ?? '' })
    // Only when another conversation opens: polling must not overwrite what staff are typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c?.id])

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['inbox-thread', id] })
    void qc.invalidateQueries({ queryKey: ['inbox-list'] })
    void qc.invalidateQueries({ queryKey: ['inbox-overview'] })
  }
  const onError = (e: unknown) => toast.error(toUserMessage(e))
  const update = useMutation({ mutationFn: (p: Parameters<typeof inboxUpdate>[1]) => inboxUpdate(id, p), onSuccess: refresh, onError })
  const addNote = useMutation({ mutationFn: () => inboxNoteAdd(id, note), onSuccess: () => { setNote(''); refresh() }, onError })
  const delNote = useMutation({ mutationFn: inboxNoteDelete, onSuccess: refresh, onError })

  if (!c || !thread.data) return null
  const { customer, orders, notes, other_conversations: others } = thread.data
  const dirty = form.name !== (c.customer_name ?? '') || form.phone !== (c.customer_phone ?? '') || form.address !== (c.customer_address ?? '')
  const successRate = customer && customer.total_orders > 0 ? Math.round((100 * customer.delivered_orders) / customer.total_orders) : null

  const createOrder = () => {
    if (onOrderDraft) return onOrderDraft()
    const p = new URLSearchParams({ conversation: id })
    if (form.name) p.set('name', form.name)
    if (form.phone) p.set('phone', form.phone)
    if (form.address) p.set('address', form.address)
    navigate(`/admin/orders/new?${p}`)
  }
  const addLabel = () => {
    const l = label.trim()
    if (!l) return
    update.mutate({ labels: [...new Set([...c.labels, l])] })
    setLabel('')
  }
  // What the order draft still needs from this chat.
  const draftChecks = [
    { label: 'Mobile', ok: /^(\+?88)?01[3-9]\d{8}$/.test(form.phone.replace(/[\s-]/g, '')) },
    { label: 'Name', ok: form.name.trim().length > 1 },
    { label: 'Address', ok: form.address.trim().length > 8 },
  ]
  const missing = draftChecks.filter((x) => !x.ok)
  const orderSummary = (o: (typeof orders)[number]) =>
    `Your order ${o.order_number} is ${o.status.replace(/_/g, ' ').toLowerCase()}. Total: ${formatMoney(o.total_amount)}. Thank you!`

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Customer</h2>
        {onClose && <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close"><X /></Button>}
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <div className="flex flex-col items-center gap-2 text-center">
          <ChatAvatar name={c.customer_name} src={c.customer_avatar} size="lg" />
          <div>
            <p className="font-semibold">{c.customer_name ?? 'Customer'}</p>
            <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground"><PlatformIcon platform={c.platform} className="size-3.5" /> {PLATFORM[c.platform].label} · since {formatDate(c.created_at)}</p>
          </div>
          {customer && (
            <div className="flex flex-wrap justify-center gap-1">
              {customer.segment && <Badge variant="neutral">{customer.segment}</Badge>}
              {customer.risk_level && customer.risk_level !== 'LOW' && <Badge variant="danger">{customer.risk_level} risk</Badge>}
            </div>
          )}
        </div>

        {form.phone && (
          <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
            <Phone className="size-3.5 text-muted-foreground" /> <span className="flex-1 tabular-nums">{form.phone}</span>
            <button type="button" aria-label="Copy number" onClick={() => { void navigator.clipboard.writeText(form.phone).then(() => toast.success('Copied')).catch(() => undefined) }}><Copy className="size-3.5" /></button>
          </div>
        )}
        {can('orders.create') && (
          <div className="flex gap-2">
            <Button size="sm" onClick={createOrder} className="min-w-0 flex-1 gap-1.5"><ShoppingBag /> <span className="truncate">Order draft</span></Button>
            {form.phone
              ? <Button size="sm" variant="outline" className="shrink-0 px-2.5" asChild><a href={`tel:${form.phone}`} title={`Call ${form.phone}`} aria-label="Call"><Phone /></a></Button>
              : <Button size="sm" variant="outline" disabled className="shrink-0 px-2.5" title="No mobile number yet" aria-label="Call"><Phone /></Button>}
          </div>
        )}

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Commerce</h3>
            <Badge variant={missing.length ? 'warning' : 'success'} className="px-1.5 py-0 text-[10px]">{missing.length ? 'Partial' : 'Ready'}</Badge>
          </div>
          <div className="rounded-lg border p-2.5 text-xs">
            <p className="mb-1.5 font-medium">Draft customer</p>
            {draftChecks.map((x) => (
              <p key={x.label} className="flex justify-between py-0.5"><span className="text-muted-foreground">{x.label}</span>
                <span className={x.ok ? 'text-emerald-600' : 'text-amber-600'}>{x.ok ? 'Found' : 'Needs review'}</span></p>
            ))}
            {missing.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1 rounded-md bg-amber-500/10 p-1.5">
                {missing.map((x) => <span key={x.label} className="rounded bg-background px-1.5 py-0.5 text-[10px]">{x.label}</span>)}
              </div>
            )}
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Contact details</h3>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name" className="h-8 text-sm" aria-label="Customer name" />
          <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Mobile number" inputMode="tel" className="h-8 text-sm" aria-label="Mobile number" />
          <Textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Delivery address" rows={2} className="min-h-0 resize-none text-sm" aria-label="Delivery address" />
          {dirty && (
            <Button size="sm" variant="outline" className="w-full" disabled={update.isPending}
              onClick={() => update.mutate({ customer_name: form.name, customer_phone: form.phone, customer_address: form.address })}>Save details</Button>
          )}
          {customer && (
            <Link to={`/admin/customers/${customer.id}`} className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
              <Link2 className="size-3" /> Store customer: {customer.full_name}
            </Link>
          )}
        </section>

        {customer && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Order record</h3>
            <div className="grid grid-cols-4 gap-1 text-center">
              {[['Orders', customer.total_orders], ['Delivered', customer.delivered_orders], ['Returned', customer.returned_orders], ['Cancelled', customer.cancelled_orders]].map(([l, v]) => (
                <div key={l} className="rounded-md bg-muted/60 px-1 py-1.5"><p className="text-sm font-semibold tabular-nums">{v}</p><p className="text-[10px] text-muted-foreground">{l}</p></div>
              ))}
            </div>
            {successRate != null && (
              <div>
                <div className="mb-1 flex justify-between text-xs"><span className="text-muted-foreground">Delivery success</span><span className="font-medium">{successRate}%</span></div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className={cn('h-full rounded-full', successRate >= 80 ? 'bg-emerald-500' : successRate >= 50 ? 'bg-amber-500' : 'bg-red-500')} style={{ width: `${successRate}%` }} />
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">Spent <Money value={customer.total_spent} />{customer.last_order_at && <> · last order {timeAgo(customer.last_order_at)}</>}</p>
          </section>
        )}

        <section className="space-y-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Orders</h3>
          {orders.length === 0 ? (
            <p className="text-xs text-muted-foreground">No orders yet{form.phone ? ' for this number' : ' (add the mobile number to find them)'}.</p>
          ) : (
            <ul className="space-y-1.5">
              {orders.map((o) => (
                <li key={o.id} className={cn('rounded-lg border p-2.5 text-xs', o.linked && 'border-primary/50 bg-primary/5')}>
                  <div className="flex items-center gap-2">
                    <Link to={`/admin/orders/${o.id}`} className="font-medium underline-offset-2 hover:underline">{o.order_number}</Link>
                    {o.linked && <Badge variant="success" className="px-1.5 py-0 text-[10px]">This chat</Badge>}
                    <span className="ml-auto"><StatusBadge value={o.status as OrderStatus} map={ORDER_STATUS} /></span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-muted-foreground">
                    <span>{formatDate(o.created_at)} · {o.items} item{o.items === 1 ? '' : 's'}</span>
                    <span className="ml-auto font-medium text-foreground"><Money value={o.total_amount} /></span>
                  </div>
                  <div className="mt-2 flex gap-1">
                    <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-[11px]" onClick={() => onDraft(orderSummary(o))}><MessageSquareText className="size-3" /> Send status</Button>
                    {!o.linked && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => update.mutate({ linked_order_id: o.id })}>Link to chat</Button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <LinkSearch title="Linked order" placeholder="Type an order number or phone to link…" empty="No order is linked to this chat yet."
          current={orders.find((o) => o.linked)?.order_number ?? null}
          find={async (q) => (await findOrdersToLink(q)).map((o) => ({ id: o.id, label: o.order_number, hint: `${o.customer_name} · ${formatMoney(o.total_amount)}` }))}
          onPick={(oid) => update.mutate({ linked_order_id: oid })} onClear={() => update.mutate({ linked_order_id: null })} />
        <LinkSearch title="Linked profile" placeholder="Search a customer by name or phone…" empty="No customer profile is linked yet."
          current={customer ? `${customer.full_name} · ${customer.phone}` : null}
          find={async (q) => (await findCustomersToLink(q)).map((x) => ({ id: x.id, label: x.full_name, hint: `${x.phone} · ${x.total_orders} orders` }))}
          onPick={(cid) => update.mutate({ customer_id: cid })} onClear={c.customer_id ? () => update.mutate({ customer_id: null }) : undefined} />

        <section className="space-y-2">
          <h3 className="flex items-center gap-1 text-xs font-medium tracking-wide text-muted-foreground uppercase"><Tag className="size-3" /> Labels</h3>
          <div className="flex flex-wrap gap-1">
            {c.labels.map((l) => (
              <Badge key={l} variant="violet" className="gap-1">
                {l}
                <button type="button" onClick={() => update.mutate({ labels: c.labels.filter((x) => x !== l) })} aria-label={`Remove ${l}`}><X className="size-3" /></button>
              </Badge>
            ))}
          </div>
          <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); addLabel() }}>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="VIP, wholesale, follow up…" className="h-8 text-sm" maxLength={40} />
            <Button size="icon-sm" variant="outline" type="submit" aria-label="Add label" className="size-8"><Plus /></Button>
          </form>
        </section>

        <section className="space-y-2">
          <h3 className="flex items-center gap-1 text-xs font-medium tracking-wide text-muted-foreground uppercase"><StickyNote className="size-3" /> Notes</h3>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Only your team sees notes" rows={2} className="min-h-0 resize-none text-sm" />
          {note.trim() && <Button size="sm" variant="outline" className="w-full" onClick={() => addNote.mutate()} disabled={addNote.isPending}>Add note</Button>}
          <ul className="space-y-1.5">
            {notes.map((n) => (
              <li key={n.id} className="group rounded-md bg-amber-500/10 p-2 text-xs">
                <p className="whitespace-pre-wrap">{n.body}</p>
                <p className="mt-1 flex items-center text-[10px] text-muted-foreground">
                  {n.created_by_name ?? 'Staff'} · {timeAgo(n.created_at)}
                  <button type="button" className="ml-auto opacity-0 group-hover:opacity-100" onClick={() => delNote.mutate(n.id)} aria-label="Delete note"><Trash2 className="size-3" /></button>
                </p>
              </li>
            ))}
          </ul>
        </section>

        {others.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Other conversations</h3>
            <ul className="space-y-1">
              {others.map((o) => (
                <li key={o.id}>
                  <button type="button" onClick={() => onOpen(o.id)} className="flex w-full items-center gap-2 rounded-md border p-2 text-left text-xs hover:bg-muted/50">
                    <PlatformIcon platform={o.platform} />
                    <span className="line-clamp-1 flex-1">{o.last_message_preview || (o.kind === 'COMMENT' ? 'Comment' : 'Message')}</span>
                    <span className="text-[10px] text-muted-foreground">{chatTime(o.last_message_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {c.customer_address && <p className="flex items-start gap-1 text-[11px] text-muted-foreground"><MapPin className="mt-0.5 size-3" /> {c.customer_address}</p>}
      </div>
    </div>
  )
}

/** Search-and-link box (an order or a customer profile for this chat). */
function LinkSearch({ title, placeholder, empty, current, find, onPick, onClear }: {
  title: string; placeholder: string; empty: string; current: string | null
  find: (q: string) => Promise<Array<{ id: string; label: string; hint: string }>>
  onPick: (id: string) => void; onClear?: () => void
}) {
  const [q, setQ] = useState('')
  const term = useDebounce(q, 250)
  const results = useQuery({ queryKey: ['inbox-link', title, term], queryFn: () => find(term), enabled: term.trim().length >= 2 })
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1 text-xs font-medium tracking-wide text-muted-foreground uppercase"><UserRound className="size-3" /> {title}</h3>
      {current ? (
        <p className="flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs"><Link2 className="size-3" /> <span className="flex-1 truncate">{current}</span>
          {onClear && <button type="button" onClick={onClear} aria-label="Unlink"><X className="size-3" /></button>}</p>
      ) : <p className="text-xs text-muted-foreground">{empty}</p>}
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="h-8 pl-8 text-sm" />
      </div>
      {term.trim().length >= 2 && (
        <ul className="space-y-0.5">
          {results.data?.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => { onPick(r.id); setQ('') }} className="flex w-full flex-col rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted">
                <span className="font-medium">{r.label}</span><span className="text-muted-foreground">{r.hint}</span>
              </button>
            </li>
          ))}
          {results.data?.length === 0 && <li className="px-2 py-1.5 text-xs text-muted-foreground">Nothing found.</li>}
        </ul>
      )}
    </section>
  )
}
