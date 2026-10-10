import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Money } from '@/components/common/money'
import { EmptyState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { deleteDeliveryZone, type DeliveryZone, listDeliveryZones, saveDeliveryZone } from '@/services/settings'
import { ListSetting, NumberSetting, SettingCard, useSettingDraft } from './setting-form'

const splitList = (v: string) => v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)

export function DeliverySettings() {
  return (
    <div className="grid gap-4">
      <DeliveryZones />
      <DeliveryOptions />
    </div>
  )
}

function DeliveryZones() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const zones = useQuery({ queryKey: ['delivery-zones'], queryFn: listDeliveryZones })
  const [editing, setEditing] = useState<Partial<DeliveryZone> | null>(null)
  const remove = useMutation({
    mutationFn: deleteDeliveryZone,
    onSuccess: () => { toast.success('Zone deleted'); void queryClient.invalidateQueries({ queryKey: ['delivery-zones'] }) },
  })
  const canEdit = can('settings.manage')
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Delivery zones</CardTitle>
        <CardDescription>Charges by district or area. The most specific match wins (area, then district, then the default zone). Return charge is used for advance calculations.</CardDescription>
        {canEdit && <CardAction><Button size="sm" onClick={() => setEditing({ is_active: true, charge: 0, return_charge: 0, sort_order: (zones.data?.length ?? 0) * 10 })}><Plus /> Add zone</Button></CardAction>}
      </CardHeader>
      <CardContent>
        {zones.isLoading ? <LoadingState /> : !zones.data?.length ? <EmptyState title="No delivery zones" description="Add at least a default zone so checkout can price delivery." /> : (
          <ul className="divide-y">
            {zones.data.map((z) => (
              <li key={z.id} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {z.name} {z.is_default && <Badge variant="info">default</Badge>} {!z.is_active && <Badge variant="neutral">inactive</Badge>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {z.districts.length ? z.districts.join(', ') : z.is_default ? 'Everywhere else' : 'No districts'}
                    {z.areas.length ? ` · areas: ${z.areas.join(', ')}` : ''}
                  </p>
                </div>
                <div className="text-right">
                  <p><Money value={z.charge} /> <span className="text-xs text-muted-foreground">· return <Money value={z.return_charge} /></span></p>
                  {z.estimated_days && <p className="text-xs text-muted-foreground">{z.estimated_days} days</p>}
                </div>
                {canEdit && (
                  <div className="flex gap-1">
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit ${z.name}`} onClick={() => setEditing(z)}><Pencil /></Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Delete ${z.name}`} onClick={() => confirm(`Delete zone ${z.name}?`) && remove.mutate(z.id)}><Trash2 /></Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ZoneDialog value={editing} onClose={() => setEditing(null)} onSaved={() => void queryClient.invalidateQueries({ queryKey: ['delivery-zones'] })} />
    </Card>
  )
}

function ZoneDialog({ value, onClose, onSaved }: { value: Partial<DeliveryZone> | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', districts: '', areas: '', charge: '0', return_charge: '0', estimated_days: '', is_default: false, is_active: true, sort_order: '0' })
  useEffect(() => {
    if (value) setForm({
      name: value.name ?? '', districts: (value.districts ?? []).join(', '), areas: (value.areas ?? []).join(', '),
      charge: String(value.charge ?? 0), return_charge: String(value.return_charge ?? 0), estimated_days: value.estimated_days ?? '',
      is_default: value.is_default ?? false, is_active: value.is_active ?? true, sort_order: String(value.sort_order ?? 0),
    })
  }, [value])
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))
  const invalid = !form.name.trim() || !(Number(form.charge) >= 0) || !(Number(form.return_charge) >= 0) || (!form.is_default && !form.districts.trim() && !form.areas.trim())
  const save = useMutation({
    mutationFn: () => saveDeliveryZone({
      id: value?.id, name: form.name.trim(), districts: splitList(form.districts), areas: splitList(form.areas),
      charge: Number(form.charge), return_charge: Number(form.return_charge), estimated_days: form.estimated_days.trim() || null,
      is_default: form.is_default, is_active: form.is_active, sort_order: Number(form.sort_order) || 0,
    }),
    onSuccess: () => { toast.success('Zone saved'); onClose(); onSaved() },
  })
  return (
    <FormDialog open={value !== null} onOpenChange={(o) => !o && onClose()} title={value?.id ? 'Edit zone' : 'New delivery zone'} submitLabel="Save"
      busy={save.isPending} disabled={invalid} onSubmit={() => save.mutate()}>
      <Field label="Name" htmlFor="z-name" required><Input id="z-name" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Inside Dhaka" /></Field>
      <Field label="Districts" htmlFor="z-districts" hint="Comma separated. Leave empty only for the default zone.">
        <Textarea id="z-districts" rows={2} value={form.districts} onChange={(e) => set({ districts: e.target.value })} />
      </Field>
      <Field label="Areas" htmlFor="z-areas" hint="Optional thana/area names for finer pricing inside a district">
        <Input id="z-areas" value={form.areas} onChange={(e) => set({ areas: e.target.value })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Delivery charge" htmlFor="z-charge" required><Input id="z-charge" type="number" min="0" step="1" value={form.charge} onChange={(e) => set({ charge: e.target.value })} /></Field>
        <Field label="Return charge" htmlFor="z-return"><Input id="z-return" type="number" min="0" step="1" value={form.return_charge} onChange={(e) => set({ return_charge: e.target.value })} /></Field>
        <Field label="Estimated days" htmlFor="z-days"><Input id="z-days" value={form.estimated_days} onChange={(e) => set({ estimated_days: e.target.value })} placeholder="1-2" /></Field>
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <label className="flex items-center gap-2 text-sm"><Switch checked={form.is_default} onCheckedChange={(v) => set({ is_default: v })} /> Default zone</label>
        <label className="flex items-center gap-2 text-sm"><Switch checked={form.is_active} onCheckedChange={(v) => set({ is_active: v })} /> Active</label>
        <Field label="Sort order" htmlFor="z-sort" className="w-24"><Input id="z-sort" type="number" value={form.sort_order} onChange={(e) => set({ sort_order: e.target.value })} /></Field>
      </div>
    </FormDialog>
  )
}

interface DeliveryMethod { code: string; name: string; extra_charge: number; active: boolean }

function DeliveryOptions() {
  const s = useSettingDraft('delivery')
  const methods = (s.get(['methods']) as DeliveryMethod[] | undefined) ?? []
  const districts = (s.get(['districts']) as string[] | undefined) ?? []
  const validate = () => {
    if (!methods.some((m) => m.active)) return 'Keep at least one delivery method active'
    if (methods.some((m) => !/^[a-z0-9_]+$/.test(m.code) || !m.name.trim())) return 'Each method needs a name and a lowercase code'
    if (new Set(methods.map((m) => m.code)).size !== methods.length) return 'Method codes must be unique'
    return null
  }
  return (
    <SettingCard setting={s} title="Delivery methods & districts" validate={validate}>
      <div className="grid gap-2">
        <p className="text-sm font-medium">Methods</p>
        {methods.map((m, i) => (
          <div key={i} className="grid grid-cols-[1fr_2fr_7rem_auto_auto] items-center gap-2">
            <Input aria-label="Code" className="font-mono" value={m.code} onChange={(e) => s.set(['methods', i, 'code'], e.target.value.toLowerCase())} />
            <Input aria-label="Name" value={m.name} onChange={(e) => s.set(['methods', i, 'name'], e.target.value)} />
            <Input aria-label="Extra charge" type="number" min="0" value={m.extra_charge} onChange={(e) => s.set(['methods', i, 'extra_charge'], Number(e.target.value) || 0)} />
            <Switch aria-label="Active" checked={m.active} onCheckedChange={(v) => s.set(['methods', i, 'active'], v)} />
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove method" onClick={() => s.set(['methods'], methods.filter((_, j) => j !== i))}><Trash2 /></Button>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">Code · name · extra charge on top of the zone charge · active</p>
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => s.set(['methods'], [...methods, { code: '', name: '', extra_charge: 0, active: true }])}><Plus /> Add method</Button>
      </div>
      <NumberSetting s={s} path={['free_delivery_threshold']} label="Free delivery over" min={0} hint="Order subtotal that unlocks free delivery. 0 turns it off." className="max-w-xs" />
      <ListSetting s={s} path={['districts']} label="Districts offered at checkout" rows={6} hint={`${districts.length} districts, one per line`} />
    </SettingCard>
  )
}
