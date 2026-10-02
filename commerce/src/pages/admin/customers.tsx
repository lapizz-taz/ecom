import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Mail, Plus } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { type Column, DataTable } from '@/components/common/data-table'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { Can } from '@/components/common/permission-gate'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { downloadCsv } from '@/lib/csv'
import { formatDate, formatDateTime, timeAgo } from '@/lib/format'
import { RISK_LEVEL, SEGMENT } from '@/lib/status'
import { createCustomer, type CustomerRow, listContactMessages, listCustomers, resolveContactMessage } from '@/services/customers'

const PAGE_SIZE = 25

export default function CustomersPage() {
  const [tab, setTab] = useState('customers')
  const [creating, setCreating] = useState(false)
  return (
    <div className="space-y-4">
      <PageHeader title="Customers" actions={<Can permission="customers.manage"><Button size="sm" onClick={() => setCreating(true)}><Plus /> Add customer</Button></Can>} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList><TabsTrigger value="customers">Customers</TabsTrigger><TabsTrigger value="messages"><Mail /> Messages</TabsTrigger></TabsList>
        <TabsContent value="customers"><CustomerList /></TabsContent>
        <TabsContent value="messages"><Messages /></TabsContent>
      </Tabs>
      <CreateCustomerDialog open={creating} onOpenChange={setCreating} />
    </div>
  )
}

function CustomerList() {
  const [state, update] = useUrlState({ q: '', segment: '', sort: 'recent', page: '1' })
  const page = Number(state.page) || 1
  const customers = useQuery({
    queryKey: ['customers', state],
    placeholderData: keepPreviousData,
    queryFn: () => listCustomers({ q: state.q, segment: state.segment as never, sort: state.sort as never, page, pageSize: PAGE_SIZE }),
  })
  const columns: Column<CustomerRow>[] = [
    { key: 'name', header: 'Customer', primary: true, cell: (c) => <div><p className="font-medium">{c.full_name}</p><p className="text-xs text-muted-foreground">{c.phone}{c.district ? ` · ${c.district}` : ''}</p></div> },
    { key: 'segment', header: 'Segment', cell: (c) => <StatusBadge value={c.segment} map={SEGMENT} /> },
    { key: 'risk', header: 'Risk', cell: (c) => <StatusBadge value={c.risk_level} map={RISK_LEVEL} /> },
    { key: 'orders', header: 'Orders', align: 'right', cell: (c) => <span>{c.total_orders} <span className="text-xs text-muted-foreground">({c.delivered_orders} delivered)</span></span> },
    { key: 'problems', header: 'Cancel / fail / return', align: 'right', hideOnMobile: true, cell: (c) => `${c.cancelled_orders} / ${c.failed_deliveries} / ${c.returned_orders}` },
    { key: 'spent', header: 'Spent', align: 'right', cell: (c) => <Money value={c.total_spent} /> },
    { key: 'last', header: 'Last order', hideOnMobile: true, cell: (c) => <span className="text-muted-foreground">{timeAgo(c.last_order_at)}</span> },
  ]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Name, phone or email" />
        <Select value={state.segment || 'all'} onValueChange={(v) => update({ segment: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All segments</SelectItem>{Object.entries(SEGMENT).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={state.sort} onValueChange={(v) => update({ sort: v })}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">Recently ordered</SelectItem><SelectItem value="spent">Top spenders</SelectItem>
            <SelectItem value="orders">Most orders</SelectItem><SelectItem value="newest">Newest</SelectItem>
          </SelectContent>
        </Select>
        <Can permission="reports.export">
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => downloadCsv('customers', customers.data?.items ?? [], [
            { header: 'Name', value: (c) => c.full_name }, { header: 'Phone', value: (c) => c.phone }, { header: 'Email', value: (c) => c.email },
            { header: 'District', value: (c) => c.district }, { header: 'Segment', value: (c) => c.segment }, { header: 'Risk', value: (c) => c.risk_level },
            { header: 'Orders', value: (c) => c.total_orders }, { header: 'Delivered', value: (c) => c.delivered_orders }, { header: 'Cancelled', value: (c) => c.cancelled_orders },
            { header: 'Failed', value: (c) => c.failed_deliveries }, { header: 'Returned', value: (c) => c.returned_orders }, { header: 'Total spent', value: (c) => c.total_spent },
            { header: 'Last order', value: (c) => formatDate(c.last_order_at) },
          ])}><Download /> Export page</Button>
        </Can>
      </div>
      <DataTable columns={columns} rows={customers.data?.items} rowKey={(c) => c.id} loading={customers.isFetching} error={customers.error}
        onRetry={() => customers.refetch()} rowHref={(c) => `/admin/customers/${c.id}`} empty={<EmptyState title="No customers found" />}
        footer={<Pagination page={page} pageSize={PAGE_SIZE} total={customers.data?.total ?? 0} onPage={(p) => update({ page: String(p) }, { resetPage: false })} />} />
    </div>
  )
}

function Messages() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const messages = useQuery({ queryKey: ['contact-messages'], queryFn: listContactMessages })
  const toggle = useMutation({
    mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) => resolveContactMessage(id, resolved),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['contact-messages'] }),
  })
  if (!messages.data?.length) return <EmptyState title="No messages" description="Messages from the Contact page appear here." />
  return (
    <div className="space-y-2">
      {messages.data.map((m) => (
        <Card key={m.id} className={m.is_resolved ? 'opacity-60' : ''}>
          <CardContent className="space-y-1 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{m.name} <span className="font-normal text-muted-foreground">{[m.phone, m.email].filter(Boolean).join(' · ')}</span></p>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{formatDateTime(m.created_at)}</span>
                {m.is_resolved && <Badge variant="success">Resolved</Badge>}
                {can('customers.manage') && <Button size="sm" variant="outline" onClick={() => toggle.mutate({ id: m.id, resolved: !m.is_resolved })}>{m.is_resolved ? 'Reopen' : 'Mark resolved'}</Button>}
              </div>
            </div>
            {m.subject && <p className="font-medium">{m.subject}</p>}
            <p className="whitespace-pre-line text-muted-foreground">{m.message}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function CreateCustomerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate()
  const [values, setValues] = useState({ full_name: '', phone: '', email: '', address: '', district: '' })
  const create = useMutation({
    mutationFn: () => createCustomer(values),
    onSuccess: (c) => { toast.success('Customer added'); onOpenChange(false); if (c?.id) navigate(`/admin/customers/${c.id}`) },
  })
  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [k]: e.target.value }))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add customer</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="nc-name" required><Input id="nc-name" value={values.full_name} onChange={set('full_name')} /></Field>
          <Field label="Phone" htmlFor="nc-phone" required><Input id="nc-phone" value={values.phone} onChange={set('phone')} /></Field>
          <Field label="Email" htmlFor="nc-email"><Input id="nc-email" value={values.email} onChange={set('email')} /></Field>
          <Field label="District" htmlFor="nc-district"><Input id="nc-district" value={values.district} onChange={set('district')} /></Field>
          <Field label="Address" htmlFor="nc-address" className="sm:col-span-2"><Input id="nc-address" value={values.address} onChange={set('address')} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !values.full_name || !values.phone}>{create.isPending && <Spinner />} Add customer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
