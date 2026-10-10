import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, TicketPercent, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { z } from 'zod'
import { type Column, DataTable } from '@/components/common/data-table'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, LoadingState } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, formatMoney, formatNumber, toNumber } from '@/lib/format'
import { ORDER_STATUS } from '@/lib/status'
import { supabase } from '@/lib/supabase'
import { couponUsage, type CouponRow, listCoupons, saveCoupon } from '@/services/coupons'
import type { OrderStatus } from '@/types/domain'

function couponState(c: CouponRow): { label: string; variant: 'success' | 'neutral' | 'warning' | 'secondary' } {
  const now = Date.now()
  if (!c.is_active) return { label: 'inactive', variant: 'neutral' }
  if (c.ends_at && new Date(c.ends_at).getTime() < now) return { label: 'expired', variant: 'secondary' }
  if (c.starts_at && new Date(c.starts_at).getTime() > now) return { label: 'scheduled', variant: 'warning' }
  if (c.usage_limit !== null && c.usage_count >= c.usage_limit) return { label: 'used up', variant: 'secondary' }
  return { label: 'active', variant: 'success' }
}

function couponSummary(c: Pick<CouponRow, 'discount_type' | 'discount_value' | 'max_discount' | 'min_order_value'>) {
  const base = c.discount_type === 'PERCENTAGE' ? `${formatNumber(c.discount_value, 2).replace(/\.00$/, '')}% off${c.max_discount ? ` (max ${formatMoney(c.max_discount)})` : ''}`
    : c.discount_type === 'FIXED' ? `${formatMoney(c.discount_value)} off` : 'Free delivery'
  return toNumber(c.min_order_value) > 0 ? `${base} on orders over ${formatMoney(c.min_order_value)}` : base
}

export default function CouponsPage() {
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ status: '' })
  const coupons = useQuery({ queryKey: ['coupons'], queryFn: listCoupons })
  const [editing, setEditing] = useState<Partial<CouponRow> | null>(null)
  const [usageFor, setUsageFor] = useState<CouponRow | null>(null)
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('coupons').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => { toast.success('Coupon deleted'); void queryClient.invalidateQueries({ queryKey: ['coupons'] }) },
  })
  const toggle = useMutation({
    mutationFn: async (c: CouponRow) => {
      const { error } = await supabase.from('coupons').update({ is_active: !c.is_active }).eq('id', c.id)
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['coupons'] }),
  })

  const rows = (coupons.data ?? []).filter((c) => !state.status || couponState(c).label === state.status)
  const columns: Column<CouponRow>[] = [
    {
      key: 'code', header: 'Code', primary: true,
      cell: (c) => <div><p className="font-mono font-medium">{c.code}</p>{c.description && <p className="text-xs text-muted-foreground">{c.description}</p>}</div>,
    },
    { key: 'discount', header: 'Discount', cell: (c) => <span className="text-sm">{couponSummary(c)}</span> },
    { key: 'state', header: 'Status', cell: (c) => { const s = couponState(c); return <Badge variant={s.variant}>{s.label}</Badge> } },
    { key: 'used', header: 'Used', align: 'right', cell: (c) => `${formatNumber(c.usage_count)}${c.usage_limit ? ` / ${formatNumber(c.usage_limit)}` : ''}` },
    { key: 'window', header: 'Valid', hideOnMobile: true, cell: (c) => <span className="text-xs text-muted-foreground">{c.starts_at ? formatDateTime(c.starts_at) : 'now'} → {c.ends_at ? formatDateTime(c.ends_at) : 'no end'}</span> },
    {
      key: 'actions', header: '', align: 'right',
      cell: (c) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Switch checked={c.is_active} onCheckedChange={() => toggle.mutate(c)} aria-label={c.is_active ? 'Deactivate' : 'Activate'} />
          <Button size="icon-sm" variant="ghost" aria-label={`Edit ${c.code}`} onClick={() => setEditing(c)}><Pencil /></Button>
          {c.usage_count === 0 && (
            <Button size="icon-sm" variant="ghost" aria-label={`Delete ${c.code}`} onClick={() => confirm(`Delete coupon ${c.code}?`) && remove.mutate(c.id)}><Trash2 /></Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader title="Coupons" description="Discount codes customers enter at checkout. Limits are enforced when the order is placed."
        actions={<Button size="sm" onClick={() => setEditing({ discount_type: 'PERCENTAGE', is_active: true })}><Plus /> Create coupon</Button>} />
      <Select value={state.status || 'all'} onValueChange={(v) => update({ status: v === 'all' ? '' : v })}>
        <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All coupons</SelectItem>
          {['active', 'scheduled', 'expired', 'used up', 'inactive'].map((s) => <SelectItem key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</SelectItem>)}
        </SelectContent>
      </Select>
      <DataTable columns={columns} rows={coupons.data ? rows : undefined} rowKey={(c) => c.id} loading={coupons.isFetching} error={coupons.error}
        onRetry={() => coupons.refetch()} onRowClick={setUsageFor}
        empty={<EmptyState icon={<TicketPercent className="size-5" />} title="No coupons" description="Create a code for a sale, a first-order discount or free delivery." />} />
      <CouponDialog value={editing} onClose={() => setEditing(null)} onSaved={() => void queryClient.invalidateQueries({ queryKey: ['coupons'] })} />
      <UsageSheet coupon={usageFor} onClose={() => setUsageFor(null)} />
    </div>
  )
}

// datetime-local <-> ISO helpers (local time in the form, UTC in the database)
const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return ''
  const d = new Date(iso)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null)

const optionalMoney = z.union([z.literal(''), z.coerce.number<string>().positive('Must be greater than zero')])
const optionalCount = z.union([z.literal(''), z.coerce.number<string>().int().positive('Must be at least 1')])
const schema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,32}$/, '3–32 letters, numbers, dashes or underscores'),
  description: z.string().trim().max(200),
  discount_type: z.enum(['PERCENTAGE', 'FIXED', 'FREE_DELIVERY']),
  discount_value: z.coerce.number<string>().min(0),
  min_order_value: z.coerce.number<string>().min(0),
  max_discount: optionalMoney,
  starts_at: z.string(),
  ends_at: z.string(),
  usage_limit: optionalCount,
  per_customer_limit: optionalCount,
  is_active: z.boolean(),
}).superRefine((v, ctx) => {
  if (v.discount_type === 'PERCENTAGE' && (v.discount_value <= 0 || v.discount_value > 100)) ctx.addIssue({ code: 'custom', path: ['discount_value'], message: 'Enter a percentage between 0.01 and 100' })
  if (v.discount_type === 'FIXED' && v.discount_value <= 0) ctx.addIssue({ code: 'custom', path: ['discount_value'], message: 'Enter an amount greater than zero' })
  if (v.starts_at && v.ends_at && v.ends_at <= v.starts_at) ctx.addIssue({ code: 'custom', path: ['ends_at'], message: 'Must be after the start' })
})

function CouponDialog({ value, onClose, onSaved }: { value: Partial<CouponRow> | null; onClose: () => void; onSaved: () => void }) {
  type V = z.input<typeof schema>
  const form = useForm<V, unknown, z.output<typeof schema>>({ resolver: zodResolver(schema) })
  const s = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n))
  useEffect(() => {
    if (value) form.reset({
      code: value.code ?? '', description: value.description ?? '', discount_type: value.discount_type ?? 'PERCENTAGE',
      discount_value: s(value.discount_value ?? 0), min_order_value: s(value.min_order_value ?? 0), max_discount: s(value.max_discount),
      starts_at: toLocalInput(value.starts_at), ends_at: toLocalInput(value.ends_at), usage_limit: s(value.usage_limit),
      per_customer_limit: s(value.per_customer_limit), is_active: value.is_active ?? true,
    })
  }, [value, form])
  const type = form.watch('discount_type')
  const save = useMutation({
    mutationFn: (v: z.output<typeof schema>) => saveCoupon({
      id: value?.id, code: v.code, description: v.description || null, discount_type: v.discount_type,
      discount_value: v.discount_type === 'FREE_DELIVERY' ? 0 : v.discount_value, min_order_value: v.min_order_value,
      max_discount: v.discount_type === 'PERCENTAGE' && v.max_discount !== '' ? v.max_discount : null,
      starts_at: fromLocalInput(v.starts_at), ends_at: fromLocalInput(v.ends_at),
      usage_limit: v.usage_limit === '' ? null : v.usage_limit, per_customer_limit: v.per_customer_limit === '' ? null : v.per_customer_limit,
      is_active: v.is_active,
    }),
    onSuccess: () => { toast.success('Coupon saved'); onClose(); onSaved() },
  })
  const e = form.formState.errors
  return (
    <FormDialog open={value !== null} onOpenChange={(o) => !o && onClose()} title={value?.id ? `Edit ${value.code}` : 'Create coupon'} submitLabel="Save"
      busy={save.isPending} wide onSubmit={form.handleSubmit((v) => save.mutate(v))}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Code" htmlFor="cp-code" required error={e.code?.message} hint="Customers type this at checkout (not case-sensitive)">
          <Input id="cp-code" className="font-mono uppercase" {...form.register('code')} />
        </Field>
        <Field label="Type">
          <Controller control={form.control} name="discount_type" render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="PERCENTAGE">Percentage off</SelectItem>
                <SelectItem value="FIXED">Fixed amount off</SelectItem>
                <SelectItem value="FREE_DELIVERY">Free delivery</SelectItem>
              </SelectContent>
            </Select>
          )} />
        </Field>
        {type !== 'FREE_DELIVERY' && (
          <Field label={type === 'PERCENTAGE' ? 'Percentage' : 'Amount'} htmlFor="cp-value" required error={e.discount_value?.message}>
            <Input id="cp-value" type="number" min="0" step="0.01" {...form.register('discount_value')} />
          </Field>
        )}
        {type === 'PERCENTAGE' && (
          <Field label="Maximum discount" htmlFor="cp-max" error={e.max_discount?.message} hint="Optional cap per order">
            <Input id="cp-max" type="number" min="0" step="0.01" {...form.register('max_discount')} />
          </Field>
        )}
        <Field label="Minimum order value" htmlFor="cp-min" error={e.min_order_value?.message}>
          <Input id="cp-min" type="number" min="0" step="0.01" {...form.register('min_order_value')} />
        </Field>
        <Field label="Starts" htmlFor="cp-start"><Input id="cp-start" type="datetime-local" {...form.register('starts_at')} /></Field>
        <Field label="Ends" htmlFor="cp-end" error={e.ends_at?.message}><Input id="cp-end" type="datetime-local" {...form.register('ends_at')} /></Field>
        <Field label="Total uses" htmlFor="cp-limit" error={e.usage_limit?.message} hint="Empty = unlimited"><Input id="cp-limit" type="number" min="1" step="1" {...form.register('usage_limit')} /></Field>
        <Field label="Uses per customer" htmlFor="cp-per" error={e.per_customer_limit?.message} hint="Counted by phone number"><Input id="cp-per" type="number" min="1" step="1" {...form.register('per_customer_limit')} /></Field>
      </div>
      <Field label="Description" htmlFor="cp-desc" hint="Internal note, e.g. which campaign it belongs to"><Textarea id="cp-desc" rows={2} {...form.register('description')} /></Field>
      <Controller control={form.control} name="is_active" render={({ field }) => (
        <label className="flex items-center gap-2 text-sm"><Switch checked={field.value} onCheckedChange={field.onChange} /> Active</label>
      )} />
    </FormDialog>
  )
}

function UsageSheet({ coupon, onClose }: { coupon: CouponRow | null; onClose: () => void }) {
  const usage = useQuery({ queryKey: ['coupons', 'usage', coupon?.id], enabled: !!coupon, queryFn: () => couponUsage(coupon!.id) })
  const active = (usage.data ?? []).filter((u) => !u.voided_at)
  return (
    <Sheet open={coupon !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="font-mono">{coupon?.code}</SheetTitle>
          <SheetDescription>{coupon && couponSummary(coupon)}</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Times used</p><p className="text-lg font-semibold">{formatNumber(coupon?.usage_count)}</p></div>
            <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Discount given</p><p className="text-lg font-semibold"><Money value={active.reduce((s, u) => s + toNumber(u.discount_amount), 0)} /></p></div>
          </div>
          {usage.isLoading ? <LoadingState /> : (usage.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">Not used yet.</p> : (
            <ul className="divide-y text-sm">
              {(usage.data ?? []).map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <Link to={`/admin/orders/${u.order_id}`} className="font-medium hover:underline">{u.orders?.order_number}</Link>
                    <p className="text-xs text-muted-foreground">{u.phone} · {formatDateTime(u.created_at)}</p>
                  </div>
                  <div className="text-right">
                    <Money value={u.discount_amount} className={u.voided_at ? 'line-through text-muted-foreground' : ''} />
                    {u.orders && <div><StatusBadge value={u.orders.status as OrderStatus} map={ORDER_STATUS} /></div>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
