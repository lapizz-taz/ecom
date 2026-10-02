import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { type Column, DataTable } from '@/components/common/data-table'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Can } from '@/components/common/permission-gate'
import { EmptyState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { formatDate, titleCase } from '@/lib/format'
import { listPurchaseOrders, listSuppliers, type PurchaseOrderRow, saveSupplier } from '@/services/purchases'
import type { Tables } from '@/types/database'

export const PO_STATUS = {
  DRAFT: 'neutral', ORDERED: 'info', PARTIALLY_RECEIVED: 'warning', RECEIVED: 'success', CANCELLED: 'secondary',
} as const
export const SETTLEMENT = { UNPAID: 'danger', PARTIALLY_PAID: 'warning', PAID: 'success' } as const

export default function PurchasesPage() {
  const [tab, setTab] = useState('orders')
  return (
    <div className="space-y-4">
      <PageHeader title="Purchases" description="Purchase orders, supplier payments and receiving stock."
        actions={<Can permission="purchases.manage"><Button size="sm" asChild><Link to="/admin/purchases/new"><Plus /> New purchase order</Link></Button></Can>} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList><TabsTrigger value="orders">Purchase orders</TabsTrigger><TabsTrigger value="suppliers">Suppliers</TabsTrigger></TabsList>
        <TabsContent value="orders"><PurchaseOrderList /></TabsContent>
        <TabsContent value="suppliers"><SupplierList /></TabsContent>
      </Tabs>
    </div>
  )
}

function PurchaseOrderList() {
  const pos = useQuery({ queryKey: ['purchases'], queryFn: () => listPurchaseOrders() })
  const columns: Column<PurchaseOrderRow>[] = [
    { key: 'po', header: 'PO', primary: true, cell: (p) => <span className="font-medium">{p.po_number}</span> },
    { key: 'supplier', header: 'Supplier', cell: (p) => p.suppliers?.name },
    { key: 'date', header: 'Ordered', cell: (p) => formatDate(p.order_date) },
    { key: 'status', header: 'Status', cell: (p) => <Badge variant={PO_STATUS[p.status]}>{titleCase(p.status)}</Badge> },
    {
      key: 'received', header: 'Received', hideOnMobile: true,
      cell: (p) => { const q = p.purchase_order_items.reduce((s, i) => s + i.quantity, 0); const r = p.purchase_order_items.reduce((s, i) => s + i.received_quantity, 0); return `${r} / ${q}` },
    },
    { key: 'payment', header: 'Payment', cell: (p) => <Badge variant={SETTLEMENT[p.payment_status]}>{titleCase(p.payment_status)}</Badge> },
    { key: 'total', header: 'Total', align: 'right', cell: (p) => <Money value={p.total_cost} /> },
    { key: 'due', header: 'Payable', align: 'right', cell: (p) => <Money value={Number(p.total_cost) - Number(p.amount_paid)} muted /> },
  ]
  return <DataTable columns={columns} rows={pos.data} rowKey={(p) => p.id} loading={pos.isLoading} error={pos.error} onRetry={() => pos.refetch()}
    rowHref={(p) => `/admin/purchases/${p.id}`} empty={<EmptyState title="No purchase orders yet" />} />
}

function SupplierList() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: listSuppliers })
  const [editing, setEditing] = useState<Partial<Tables<'suppliers'>> | null>(null)
  const save = useMutation({
    mutationFn: () => saveSupplier({
      id: editing?.id, name: editing?.name ?? '', contact_person: editing?.contact_person ?? null, phone: editing?.phone ?? null,
      email: editing?.email ?? null, address: editing?.address ?? null, notes: editing?.notes ?? null, is_active: editing?.is_active ?? true,
    }),
    onSuccess: () => { toast.success('Supplier saved'); setEditing(null); void queryClient.invalidateQueries({ queryKey: ['suppliers'] }) },
  })
  const set = (k: keyof Tables<'suppliers'>) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setEditing((s) => ({ ...s, [k]: e.target.value }))
  return (
    <Card>
      <CardContent className="space-y-3">
        {can('purchases.manage') && <Button size="sm" onClick={() => setEditing({ is_active: true })}><Plus /> Add supplier</Button>}
        {!suppliers.data?.length ? <EmptyState title="No suppliers yet" /> : (
          <ul className="divide-y">
            {suppliers.data.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div>
                  <p className="font-medium">{s.name} {!s.is_active && <Badge variant="neutral">inactive</Badge>}</p>
                  <p className="text-xs text-muted-foreground">{[s.contact_person, s.phone, s.email].filter(Boolean).join(' · ')}</p>
                </div>
                {can('purchases.manage') && <Button size="icon-sm" variant="ghost" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}><Pencil /></Button>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing?.id ? 'Edit supplier' : 'New supplier'}</DialogTitle></DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="s-name" required className="sm:col-span-2"><Input id="s-name" value={editing?.name ?? ''} onChange={set('name')} /></Field>
            <Field label="Contact person" htmlFor="s-contact"><Input id="s-contact" value={editing?.contact_person ?? ''} onChange={set('contact_person')} /></Field>
            <Field label="Phone" htmlFor="s-phone"><Input id="s-phone" value={editing?.phone ?? ''} onChange={set('phone')} /></Field>
            <Field label="Email" htmlFor="s-email"><Input id="s-email" value={editing?.email ?? ''} onChange={set('email')} /></Field>
            <Field label="Address" htmlFor="s-address"><Input id="s-address" value={editing?.address ?? ''} onChange={set('address')} /></Field>
            <Field label="Notes" htmlFor="s-notes" className="sm:col-span-2"><Textarea id="s-notes" rows={2} value={editing?.notes ?? ''} onChange={set('notes')} /></Field>
            <label className="flex items-center gap-2 text-sm"><Switch checked={editing?.is_active ?? true} onCheckedChange={(v) => setEditing((s) => ({ ...s, is_active: v }))} /> Active</label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={() => save.mutate()} disabled={!editing?.name || save.isPending}>{save.isPending && <Spinner />} Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
