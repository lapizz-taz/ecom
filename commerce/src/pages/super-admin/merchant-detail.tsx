import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, Circle, Pencil, Pin, UserPlus } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { MerchantBillingTab, MerchantFeaturesTab } from '@/features/platform/billing/merchant-tabs'
import { MERCHANT_STATUS } from '@/features/platform/nav'
import { MerchantCreditsTab } from '@/features/platform/services/merchant-credits-tab'
import { usePlatform } from '@/features/platform/platform-context'
import { StatusChangeDialog } from '@/features/platform/status-change-dialog'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDate, formatDateTime, formatMoney, formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { addMerchantNote, getMerchant, listEmployees, type MerchantDetail, setMerchantOwner, updateMerchant } from '@/services/platform'

/** Tabs from other modules, shown to employees who can view that module for this merchant. */
const merchantTabs: Array<{ key: string; label: string; module: string; render: (m: MerchantDetail) => ReactNode }> = [
  { key: 'billing', label: 'Plan & billing', module: 'subscriptions', render: (m) => <MerchantBillingTab detail={m} /> },
  { key: 'features', label: 'Features', module: 'features', render: (m) => <MerchantFeaturesTab detail={m} /> },
  { key: 'credits', label: 'Credits & usage', module: 'credits', render: (m) => <MerchantCreditsTab detail={m} /> },
]

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{children ?? '—'}</span>
    </div>
  )
}

function EditDialog({ detail, open, onOpenChange }: { detail: MerchantDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const m = detail.merchant
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const employees = useQuery({ queryKey: ['platform-employees'], queryFn: listEmployees, enabled: open && can('employees') })
  const [form, setForm] = useState({
    name: m.name, slug: m.slug ?? '', owner_email: m.owner_email ?? '', phone: m.phone ?? '', business_type: m.business_type ?? '',
    website: m.website ?? '', address: m.address ?? '', notes: m.notes ?? '', is_demo: m.is_demo, account_manager_id: detail.account_manager?.id ?? '',
  })
  const save = useMutation({
    mutationFn: () => {
      const patch: Record<string, unknown> = { ...form }
      if (!detail.can.manage || form.account_manager_id === (detail.account_manager?.id ?? '')) delete patch.account_manager_id
      return updateMerchant(m.id, patch)
    },
    onSuccess: () => {
      toast.success('Saved')
      void queryClient.invalidateQueries({ queryKey: ['platform-merchant', m.id] })
      onOpenChange(false)
    },
    onError: (e) => toast.error((e as Error).message),
  })
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Edit merchant" wide busy={save.isPending} onSubmit={() => save.mutate()} submitLabel="Save">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Business name" required><Input value={form.name} onChange={set('name')} /></Field>
        <Field label="Short name" hint="Lowercase letters, numbers and dashes"><Input value={form.slug} onChange={set('slug')} /></Field>
        <Field label="Owner e-mail"><Input type="email" value={form.owner_email} onChange={set('owner_email')} /></Field>
        <Field label="Phone"><Input value={form.phone} onChange={set('phone')} /></Field>
        <Field label="Business type"><Input value={form.business_type} onChange={set('business_type')} placeholder="Fashion, electronics…" /></Field>
        <Field label="Website"><Input value={form.website} onChange={set('website')} /></Field>
        <Field label="Address" className="sm:col-span-2"><Input value={form.address} onChange={set('address')} /></Field>
        {detail.can.manage && can('employees') && (
          <Field label="Account manager">
            <Select value={form.account_manager_id || 'none'} onValueChange={(v) => setForm((f) => ({ ...f, account_manager_id: v === 'none' ? '' : v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nobody</SelectItem>
                {(employees.data ?? []).filter((e) => e.is_active).map((e) => <SelectItem key={e.user_id} value={e.user_id}>{e.full_name || e.email}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        )}
        <label className="flex items-center gap-2 self-end text-sm">
          <Checkbox checked={form.is_demo} onCheckedChange={(v) => setForm((f) => ({ ...f, is_demo: v === true }))} /> Demo / test merchant
        </label>
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={3} value={form.notes} onChange={set('notes')} /></Field>
      </div>
    </FormDialog>
  )
}

function OwnerDialog({ merchantId, open, onOpenChange }: { merchantId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ email: '', full_name: '', password: '' })
  const save = useMutation({
    mutationFn: () => setMerchantOwner(merchantId, { email: form.email.trim(), full_name: form.full_name.trim(), password: form.password || undefined }),
    onSuccess: (r) => {
      toast.success(r.owner_invited ? 'Invitation sent' : 'Owner added')
      void queryClient.invalidateQueries({ queryKey: ['platform-merchant', merchantId] })
      onOpenChange(false)
    },
    onError: (e) => toast.error((e as Error).message),
  })
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Add the owner" description="They get an invitation e-mail to set a password, unless you set one here."
      busy={save.isPending} onSubmit={() => save.mutate()} submitLabel="Add owner" disabled={!form.email || form.full_name.length < 2}>
      <div className="grid gap-3">
        <Field label="Name" required><Input value={form.full_name} onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))} /></Field>
        <Field label="E-mail" required><Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></Field>
        <Field label="Password (optional)" hint="At least 10 characters. Leave empty to send an invitation."><Input type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} /></Field>
      </div>
    </FormDialog>
  )
}

export default function MerchantDetailPage() {
  const { id = '' } = useParams()
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ tab: 'overview' })
  const [edit, setEdit] = useState(false)
  const [owner, setOwner] = useState(false)
  const [status, setStatus] = useState<'ACTIVE' | 'SUSPENDED' | 'CLOSED' | null>(null)
  const [note, setNote] = useState('')
  const detail = useQuery({ queryKey: ['platform-merchant', id], queryFn: () => getMerchant(id) })
  const addNote = useMutation({
    mutationFn: (pinned: boolean) => addMerchantNote(id, note.trim(), pinned),
    onSuccess: () => { setNote(''); void queryClient.invalidateQueries({ queryKey: ['platform-merchant', id] }) },
    onError: (e) => toast.error((e as Error).message),
  })

  if (detail.error) return <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
  if (!detail.data) return <LoadingState />
  const d = detail.data
  const m = d.merchant
  const hasOwner = d.staff.some((s) => s.role === 'OWNER' && s.is_active)
  const extraTabs = merchantTabs.filter((t) => can(t.module, 'view', id))

  return (
    <div className="space-y-4">
      <Link to="/super-admin/merchants" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Merchants</Link>
      <PageHeader
        title={<span className="flex items-center gap-2">{m.name} <StatusBadge value={m.status} map={MERCHANT_STATUS} />{m.is_demo && <Badge variant="violet">Demo</Badge>}</span>}
        description={`Merchant #${m.number} · joined ${formatDate(m.created_at)}${m.status_reason && m.status !== 'ACTIVE' ? ` · ${m.status_reason}` : ''}`}
        actions={<>
          {d.can.edit && <Button size="sm" variant="outline" onClick={() => setEdit(true)}><Pencil /> Edit</Button>}
          {d.can.manage && !hasOwner && m.status !== 'CLOSED' && <Button size="sm" variant="outline" onClick={() => setOwner(true)}><UserPlus /> Add owner</Button>}
          {d.can.manage && m.status !== 'ACTIVE' && m.status !== 'CLOSED' && <Button size="sm" onClick={() => setStatus('ACTIVE')}>Activate</Button>}
          {d.can.manage && m.status === 'ACTIVE' && <Button size="sm" variant="outline" onClick={() => setStatus('SUSPENDED')}>Suspend</Button>}
          {d.can.manage && m.status !== 'CLOSED' && <Button size="sm" variant="ghost" onClick={() => setStatus('CLOSED')}>Close…</Button>}
        </>}
      />
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="stores">Stores & couriers</TabsTrigger>
          <TabsTrigger value="staff">Staff</TabsTrigger>
          {extraTabs.map((t) => <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>)}
          <TabsTrigger value="issues">Issues & activity</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Orders (30 days)" value={formatNumber(d.activity.orders_30d)} hint={`${formatNumber(d.activity.orders_total)} all time`} />
            <StatCard label="Order value (30 days)" value={formatMoney(d.activity.order_value_30d)} hint="The merchant's sales, not platform revenue" />
            <StatCard label="Returns (30 days)" value={formatNumber(d.activity.returns_30d)} hint={`${formatNumber(d.activity.shipments_30d)} parcels booked`} />
            <StatCard label="Last order" value={d.activity.last_order_at ? timeAgo(d.activity.last_order_at) : '—'} hint={`${formatNumber(d.activity.products)} products · ${formatNumber(d.activity.stock_units)} units in stock`} />
            <StatCard label="SMS sent (30 days)" value={formatNumber(d.activity.sms_sent_30d)} />
            <StatCard label="Courier checks (30 days)" value={formatNumber(d.activity.courier_checks_30d)} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-sm">Profile</CardTitle></CardHeader>
              <CardContent>
                <Row label="Owner e-mail">{m.owner_email}</Row>
                <Row label="Phone">{m.phone}</Row>
                <Row label="Business type">{m.business_type}</Row>
                <Row label="Website">{m.website}</Row>
                <Row label="Address">{m.address}</Row>
                <Row label="Account manager">{d.account_manager?.name}</Row>
                <Row label="Time zone">{m.timezone}</Row>
                {m.notes && <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{m.notes}</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Onboarding · {d.onboarding.done} of {d.onboarding.total}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {d.onboarding.steps.map((s) => (
                  <div key={s.key} className="flex items-center gap-2 text-sm">
                    {s.done ? <Check className="size-4 text-emerald-500" /> : <Circle className="size-4 text-muted-foreground" />}
                    <span className={s.done ? '' : 'text-muted-foreground'}>{s.label}</span>
                  </div>
                ))}
                <p className="pt-2 text-xs text-muted-foreground">Worked out from what exists for this merchant (owner login, stores, couriers, orders).</p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="stores" className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="text-sm">Stores</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {d.stores.length === 0 && <p className="text-sm text-muted-foreground">No Shopify or WooCommerce store connected.</p>}
              {d.stores.map((s) => (
                <div key={s.id} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{s.shop_domain}</span>
                    <Badge variant={s.status === 'CONNECTED' ? 'success' : s.status === 'ERROR' ? 'danger' : 'neutral'}>{s.status.toLowerCase()}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{s.platform.toLowerCase()} · {formatNumber(s.orders_imported)} orders imported · last sync {s.last_sync_at ? timeAgo(s.last_sync_at) : 'never'}</p>
                  {s.last_error && <p className="mt-1 text-xs text-red-500">{s.last_error}</p>}
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm">Couriers</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {d.couriers.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 border-b py-1.5 text-sm last:border-0">
                  <span>{c.name}{c.provider && <span className="ml-1 text-xs text-muted-foreground">({c.provider})</span>}</span>
                  <Badge variant={c.api_enabled ? 'success' : 'neutral'}>{c.api_enabled ? (c.api_status ?? 'API').toLowerCase() : c.is_active ? 'manual' : 'off'}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="staff">
          <Card className="py-0">
            {d.staff.length === 0 ? <EmptyState title="No staff yet" description="Add the owner to start." /> : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground"><tr><th className="px-4 py-2 font-medium">Name</th><th className="px-4 py-2 font-medium">Role</th><th className="px-4 py-2 font-medium">Last seen</th></tr></thead>
                <tbody>
                  {d.staff.map((s) => (
                    <tr key={s.id} className="border-t">
                      <td className="px-4 py-2">{s.full_name || s.email}<p className="text-xs text-muted-foreground">{s.email}</p></td>
                      <td className="px-4 py-2"><Badge variant={s.is_active ? 'neutral' : 'danger'}>{s.role.toLowerCase().replace(/_/g, ' ')}{!s.is_active && ' · off'}</Badge></td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{s.last_seen_at ? timeAgo(s.last_seen_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <p className="mt-2 text-xs text-muted-foreground">Passwords are never shown. To look at the merchant's screens, open a time-limited support view from Support & Issues.</p>
        </TabsContent>

        {extraTabs.map((t) => <TabsContent key={t.key} value={t.key}>{t.render(d)}</TabsContent>)}

        <TabsContent value="issues" className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="text-sm">Open errors and warnings</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {d.errors.length === 0 && <p className="text-sm text-muted-foreground">Nothing unresolved.</p>}
              {d.errors.map((e) => (
                <div key={e.id} className="rounded-md border p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant={e.level === 'ERROR' ? 'danger' : 'warning'}>{e.category.toLowerCase()}</Badge>
                    <span className="text-muted-foreground">{e.occurrences}× · {timeAgo(e.last_seen_at)}</span>
                  </div>
                  <p className="mt-1 break-words">{e.message}</p>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm">Recent activity in the business</CardTitle></CardHeader>
            <CardContent className="space-y-1.5">
              {d.recent_activity.length === 0 && <p className="text-sm text-muted-foreground">No activity recorded.</p>}
              {d.recent_activity.map((a, i) => (
                <div key={i} className="flex justify-between gap-3 text-xs"><code className="truncate">{a.action}</code><span className="shrink-0 text-muted-foreground">{a.actor_email ?? 'system'} · {timeAgo(a.created_at)}</span></div>
              ))}
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle className="text-sm">Platform actions on this merchant</CardTitle></CardHeader>
            <CardContent className="space-y-1.5">
              {d.platform_log.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
              {d.platform_log.map((a, i) => (
                <div key={i} className="flex justify-between gap-3 text-xs">
                  <span className="truncate"><code>{a.action}</code>{a.reason && <span className="ml-2 text-muted-foreground">“{a.reason}”</span>}</span>
                  <span className="shrink-0 text-muted-foreground">{a.actor_email ?? 'system'} · {formatDateTime(a.created_at)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notes" className="space-y-3">
          {d.can.edit && (
            <Card>
              <CardContent className="space-y-2 pt-4">
                <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Internal note — only the platform team sees it" />
                <div className="flex gap-2">
                  <Button size="sm" disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate(false)}>Add note</Button>
                  <Button size="sm" variant="outline" disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate(true)}><Pin /> Add pinned</Button>
                </div>
              </CardContent>
            </Card>
          )}
          {d.notes.length === 0 ? <EmptyState title="No notes yet" /> : d.notes.map((n) => (
            <Card key={n.id} className="gap-1 px-4 py-3">
              <p className="whitespace-pre-wrap text-sm">{n.pinned && <Pin className="mr-1 inline size-3.5" />}{n.body}</p>
              <p className="text-xs text-muted-foreground">{n.author ?? 'unknown'} · {formatDateTime(n.created_at)}</p>
            </Card>
          ))}
        </TabsContent>
      </Tabs>
      {edit && <EditDialog detail={d} open={edit} onOpenChange={setEdit} />}
      {owner && <OwnerDialog merchantId={m.id} open={owner} onOpenChange={setOwner} />}
      {status && <StatusChangeDialog ids={[m.id]} status={status} open onOpenChange={(o) => !o && setStatus(null)}
        onDone={() => void queryClient.invalidateQueries({ queryKey: ['platform-merchant', id] })} />}
    </div>
  )
}
