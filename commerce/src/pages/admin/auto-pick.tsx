import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PhoneCall, Shuffle, UserCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { LoadingState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/features/auth/auth-context'
import { formatNumber } from '@/lib/format'
import { type AutoPickSettings, autoPickOverview, runAutoPick, saveAutoPick } from '@/services/order-tools'

/** Auto Pick Orders: new web orders go straight to a call agent. */
export default function AutoPickPage() {
  const { can } = useAuth()
  const manage = can('orders.assign')
  const queryClient = useQueryClient()
  const overview = useQuery({ queryKey: ['auto-pick'], queryFn: autoPickOverview, refetchInterval: 60_000 })
  const [draft, setDraft] = useState<AutoPickSettings | null>(null)
  useEffect(() => { if (overview.data) setDraft(overview.data.settings) }, [overview.data])
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['auto-pick'] })
    void queryClient.invalidateQueries({ queryKey: ['orders'] })
  }
  const save = useMutation({ mutationFn: () => saveAutoPick(draft!), onSuccess: () => { toast.success('Auto Pick saved'); refresh() } })
  const run = useMutation({ mutationFn: runAutoPick, onSuccess: (n) => { toast.success(n ? `${n} waiting orders assigned` : 'Nothing waiting to assign'); refresh() } })

  const o = overview.data
  if (!o || !draft) return <LoadingState />
  const changed = JSON.stringify(draft) !== JSON.stringify(o.settings)
  const toggleAgent = (id: string, on: boolean) => setDraft({ ...draft, agent_ids: on ? [...draft.agent_ids, id] : draft.agent_ids.filter((x) => x !== id) })

  return (
    <div className="space-y-4">
      <PageHeader title="Auto Pick Orders"
        description="Every new web order is handed to one of your call agents as it arrives, so nothing waits unowned. Agents see their orders in Auto Call Center."
        actions={(
          <>
            <Button size="sm" variant="outline" asChild><Link to="/admin/orders/call-center"><PhoneCall /> Auto Call Center</Link></Button>
            {manage && <Button size="sm" variant="outline" onClick={() => run.mutate()} disabled={!o.settings.enabled || run.isPending || o.unassigned === 0}>
              {run.isPending ? <Spinner /> : <Shuffle />} Assign {formatNumber(o.unassigned)} waiting
            </Button>}
          </>
        )} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Auto Pick" value={o.settings.enabled ? 'On' : 'Off'} tone={o.settings.enabled ? 'positive' : undefined}
          hint={o.settings.enabled ? `${o.settings.mode === 'round_robin' ? 'Round robin' : 'Least busy first'} · ${o.settings.agent_ids.length} agents` : 'New orders stay unassigned'} />
        <StatCard label="Waiting, not assigned" value={formatNumber(o.unassigned)} tone={o.unassigned > 0 ? 'warning' : undefined} to="/admin/orders/web" />
        <StatCard label="Open with agents" value={formatNumber(o.agents.reduce((s, a) => s + a.open, 0))} />
        <StatCard label="Approved today" value={formatNumber(o.agents.reduce((s, a) => s + a.approved_today, 0))} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Settings</CardTitle>
            <CardDescription>Orders that arrive while it's off can be handed out with “Assign waiting”.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
              <span className="text-sm font-medium">Assign new web orders automatically</span>
              <Switch checked={draft.enabled} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })} disabled={!manage} />
            </label>
            <Field label="How to share them">
              <RadioGroup value={draft.mode} onValueChange={(v) => setDraft({ ...draft, mode: v as AutoPickSettings['mode'] })} disabled={!manage} className="grid gap-2">
                <label className="flex items-start gap-2 text-sm"><RadioGroupItem value="round_robin" className="mt-0.5" />
                  <span>Round robin<span className="block text-xs text-muted-foreground">One by one in turn, so everyone gets the same number.</span></span></label>
                <label className="flex items-start gap-2 text-sm"><RadioGroupItem value="least_open" className="mt-0.5" />
                  <span>Least busy first<span className="block text-xs text-muted-foreground">To whoever has the fewest open orders right now.</span></span></label>
              </RadioGroup>
            </Field>
            <Field label="Most open orders per agent" htmlFor="ap-max" hint="0 = no limit. When everyone is full, new orders wait unassigned.">
              <Input id="ap-max" type="number" min={0} className="w-32" value={draft.max_open} disabled={!manage}
                onChange={(e) => setDraft({ ...draft, max_open: Math.max(0, Number(e.target.value) || 0) })} />
            </Field>
            {manage && <Button className="w-fit" onClick={() => save.mutate()} disabled={!changed || save.isPending || (draft.enabled && draft.agent_ids.length === 0)}>
              {save.isPending && <Spinner />} Save
            </Button>}
            {draft.enabled && draft.agent_ids.length === 0 && <p className="text-xs text-amber-700">Tick at least one agent.</p>}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-sm">Agents</CardTitle>
            <CardDescription>Tick who receives orders. Staff who can change order status are listed.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b"><th className="w-8 py-1.5" /><th className="text-left font-medium">Agent</th><th className="px-2 text-right font-medium">Open</th>
                  <th className="px-2 text-right font-medium">Call-backs due</th><th className="px-2 text-right font-medium">Assigned today</th><th className="pl-2 text-right font-medium">Approved today</th></tr>
              </thead>
              <tbody className="divide-y tabular-nums">
                {o.agents.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2"><Checkbox checked={draft.agent_ids.includes(a.id)} disabled={!manage} onCheckedChange={(v) => toggleAgent(a.id, v === true)} aria-label={`Give orders to ${a.name}`} /></td>
                    <td><span className="font-medium">{a.name}</span><span className="block text-xs text-muted-foreground">{a.role}</span></td>
                    <td className="px-2 text-right">{formatNumber(a.open)}</td>
                    <td className={`px-2 text-right ${a.callbacks_due > 0 ? 'text-amber-600' : ''}`}>{formatNumber(a.callbacks_due)}</td>
                    <td className="px-2 text-right">{formatNumber(a.assigned_today)}</td>
                    <td className="pl-2 text-right text-emerald-600">{formatNumber(a.approved_today)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {o.agents.length === 0 && <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><UserCheck className="size-4" /> Add staff in HRM → Users &amp; Roles first.</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
