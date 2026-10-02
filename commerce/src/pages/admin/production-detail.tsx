import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { ProductionActions } from '@/features/production/production-actions'
import { useStaffDirectory } from '@/hooks/use-staff-directory'
import { formatDateTime, titleCase } from '@/lib/format'
import { ORDER_STATUS, PRODUCTION_STATUS } from '@/lib/status'
import { getProduction, updateProduction } from '@/services/production'
import type { Enums } from '@/types/database'

export default function ProductionDetailPage() {
  const { id = '' } = useParams()
  const { can } = useAuth()
  const { staff } = useStaffDirectory()
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['production', 'detail', id], queryFn: () => getProduction(id) })
  const [form, setForm] = useState({ assigned_to: '', priority: 'NORMAL' as Enums<'production_priority'>, deadline: '', notes: '' })
  useEffect(() => {
    const p = query.data
    if (p) setForm({ assigned_to: p.assigned_to ?? '', priority: p.priority, deadline: p.deadline ?? '', notes: p.notes ?? '' })
  }, [query.data])
  const save = useMutation({
    mutationFn: () => updateProduction(id, { assigned_to: form.assigned_to || null, priority: form.priority, deadline: form.deadline || null, notes: form.notes || null }),
    onSuccess: () => { toast.success('Saved'); void queryClient.invalidateQueries({ queryKey: ['production'] }) },
  })
  if (query.isLoading) return <LoadingState />
  if (query.error || !query.data) return <ErrorState error={query.error ?? new Error('NOT_FOUND: Not found')} />
  const p = query.data
  const editable = can('production.manage')

  return (
    <div className="space-y-4">
      <Link to="/admin/production" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Production</Link>
      <PageHeader title={<span className="flex items-center gap-2">Production · {p.orders?.order_number} <StatusBadge value={p.status} map={PRODUCTION_STATUS} /></span>}
        description={<>Order status: {p.orders ? ORDER_STATUS[p.orders.status].label : '—'} · <Link to={`/admin/orders/${p.order_id}`} className="underline">Open order</Link></>}
        actions={<ProductionActions id={p.id} status={p.status} size="default" />} />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Items to prepare</CardTitle></CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">
                {p.production_items.map((i) => (
                  <li key={i.id} className="flex justify-between gap-3 py-2">
                    <span><span className="font-medium">{i.product_name}</span>{i.variant_title ? ` · ${i.variant_title}` : ''} <span className="text-muted-foreground">{i.sku}</span></span>
                    <span className="font-medium">× {i.quantity}{i.requires_production && <span className="ml-2 text-xs text-violet-700">make</span>}</span>
                  </li>
                ))}
              </ul>
              {p.orders?.customer_note && <p className="mt-3 rounded-md bg-muted/60 p-2 text-sm"><span className="font-medium">Customer note:</span> {p.orders.customer_note}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm">History</CardTitle></CardHeader>
            <CardContent>
              <ol className="space-y-2 border-l pl-4 text-sm">
                {p.production_status_history.map((h) => (
                  <li key={h.id}>
                    <p className="font-medium">{h.from_status ? `${PRODUCTION_STATUS[h.from_status].label} → ` : ''}{PRODUCTION_STATUS[h.to_status].label}{h.action ? ` · ${titleCase(h.action)}` : ''}</p>
                    {h.note && <p className="text-muted-foreground">{h.note}</p>}
                    <p className="text-xs text-muted-foreground">{formatDateTime(h.created_at)} · {h.actor_name}</p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
        <Card className="h-fit">
          <CardHeader><CardTitle className="text-sm">Assignment</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Field label="Assigned to">
              <Select value={form.assigned_to || 'none'} onValueChange={(v) => setForm({ ...form, assigned_to: v === 'none' ? '' : v })} disabled={!editable}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">Unassigned</SelectItem>{staff.filter((s) => s.is_active).map((s) => <SelectItem key={s.id} value={s.id}>{s.full_name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Priority">
              <Select value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v as typeof form.priority })} disabled={!editable}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{['URGENT', 'HIGH', 'NORMAL', 'LOW'].map((v) => <SelectItem key={v} value={v}>{titleCase(v)}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Deadline" htmlFor="pd-deadline"><Input id="pd-deadline" type="date" value={form.deadline} disabled={!editable} onChange={(e) => setForm({ ...form, deadline: e.target.value })} /></Field>
            <Field label="Notes" htmlFor="pd-notes"><Textarea id="pd-notes" rows={3} value={form.notes} disabled={!editable} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
            {editable && <Button className="w-full" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending && <Spinner />} Save</Button>}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
