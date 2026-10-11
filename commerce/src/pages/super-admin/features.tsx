import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { ConfigHistory } from '@/features/platform/config-history'
import { usePlatform } from '@/features/platform/platform-context'
import { useUrlState } from '@/hooks/use-url-state'
import { toast } from '@/lib/toast'
import {
  applyFeatureBulk, ENTITLEMENT, type Feature, listPlans, previewFeatureBulk, saveFeature,
} from '@/services/billing'
import { listMerchants } from '@/services/platform'

const STAGE = { GA: { label: 'Released', variant: 'success' }, BETA: { label: 'Early access', variant: 'violet' }, INTERNAL: { label: 'Internal', variant: 'neutral' } } as const

function Catalogue() {
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const data = useQuery({ queryKey: ['platform-plans'], queryFn: listPlans })
  const [change, setChange] = useState<{ feature: Feature; patch: Partial<Pick<Feature, 'globally_enabled' | 'release_stage'>> } | null>(null)
  if (data.error) return <ErrorState error={data.error} onRetry={() => data.refetch()} />
  if (!data.data) return <LoadingState />
  const manage = can('features', 'manage')
  const plansWith = (code: string) => data.data.plans.filter((p) => p.status === 'ACTIVE' && p.features[code]).map((p) => p.name)
  return (
    <>
      <Card className="gap-0 py-0">
        {data.data.features.map((f) => (
          <div key={f.code} className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 text-sm last:border-0">
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 font-medium">{f.name}{f.is_core ? <Badge variant="neutral">always on</Badge> : <Badge variant={STAGE[f.release_stage].variant}>{STAGE[f.release_stage].label}</Badge>}</span>
              <span className="block text-xs text-muted-foreground">
                {f.description}{!f.is_core && ` · in ${plansWith(f.code).join(', ') || 'no plan'}`}{f.depends_on && ` · needs the ${f.depends_on.replace(/_/g, ' ')} connection`}
              </span>
            </span>
            {!f.is_core && (
              <span className="flex items-center gap-3">
                <Select disabled={!manage} value={f.release_stage} onValueChange={(v) => setChange({ feature: f, patch: { release_stage: v as Feature['release_stage'] } })}>
                  <SelectTrigger size="sm" className="w-36" aria-label={`${f.name} release stage`}><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(STAGE).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent>
                </Select>
                <Switch disabled={!manage} checked={f.globally_enabled} aria-label={`${f.name} for everyone`} onCheckedChange={(v) => setChange({ feature: f, patch: { globally_enabled: v } })} />
              </span>
            )}
          </div>
        ))}
      </Card>
      <p className="mt-2 text-xs text-muted-foreground">The switch turns a feature on or off for every merchant at once. Early access opens it only to merchants given an exception. Plans decide the rest (Subscriptions & Plans).</p>
      {change && (
        <ConfirmDialog open onOpenChange={(o) => !o && setChange(null)} reason reasonRequired destructive={change.patch.globally_enabled === false}
          title={change.patch.globally_enabled === false ? `Switch ${change.feature.name} off for every merchant?`
            : change.patch.globally_enabled ? `Switch ${change.feature.name} back on?` : `Move ${change.feature.name} to "${STAGE[change.patch.release_stage!].label}"?`}
          description={change.patch.globally_enabled === false ? 'The backend refuses it for everyone straight away (store connections, imports, background jobs). Merchant data is kept.' : 'Takes effect immediately. The previous setting stays in the history.'}
          confirmLabel="Apply"
          onConfirm={async (reason) => {
            try {
              await saveFeature(change.feature.code, { ...change.patch, reason })
              void queryClient.invalidateQueries({ queryKey: ['platform-plans'] })
              toast.success('Saved')
            } catch (e) {
              toast.error((e as Error).message)
              throw e
            }
          }} />
      )}
    </>
  )
}

/** One feature for many merchants: pick, preview what changes, then apply. */
function Bulk() {
  const queryClient = useQueryClient()
  const plans = useQuery({ queryKey: ['platform-plans'], queryFn: listPlans })
  const [q, setQ] = useState('')
  const merchants = useQuery({ queryKey: ['platform-merchants', 'bulk-features', q], queryFn: () => listMerchants({ q }, 'number', 'asc', 1, 200) })
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [code, setCode] = useState('')
  const [mode, setMode] = useState<'on' | 'off' | 'plan'>('on')
  const [reason, setReason] = useState('')
  const enabled = mode === 'plan' ? null : mode === 'on'
  const preview = useMutation({ mutationFn: () => previewFeatureBulk([...picked], code, enabled) })
  const apply = useMutation({
    mutationFn: () => applyFeatureBulk([...picked], code, enabled, reason.trim(), preview.data!.token),
    onSuccess: (r) => {
      toast.success(`Changed for ${r.changed} merchant${r.changed === 1 ? '' : 's'}`)
      preview.reset()
      setPicked(new Set())
      setReason('')
      void queryClient.invalidateQueries({ queryKey: ['platform-merchant-billing'] })
    },
    onError: (e) => toast.error((e as Error).message),
  })
  const toggle = (id: string) => { preview.reset(); setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n }) }
  const optional = (plans.data?.features ?? []).filter((f) => !f.is_core)
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <Card className="gap-0 py-0">
        <div className="flex items-center gap-2 border-b p-3">
          <SearchInput value={q} onChange={setQ} placeholder="Find merchants" />
          <span className="text-xs text-muted-foreground">{picked.size} selected</span>
        </div>
        <div className="max-h-[28rem] overflow-y-auto">
          {merchants.error ? <ErrorState error={merchants.error} /> : !merchants.data ? <LoadingState /> : merchants.data.items.length === 0 ? <EmptyState title="No merchants" /> : merchants.data.items.map((m) => (
            <label key={m.id} className="flex cursor-pointer items-center gap-3 border-b px-4 py-2 text-sm last:border-0 hover:bg-muted/40">
              <Checkbox checked={picked.has(m.id)} onCheckedChange={() => toggle(m.id)} />
              <span className="min-w-0 flex-1 truncate">#{m.number} {m.name}</span>
              <Badge variant="neutral">{m.status.toLowerCase()}</Badge>
            </label>
          ))}
        </div>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-sm">Change</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Field label="Feature">
            <Select value={code} onValueChange={(v) => { preview.reset(); setCode(v) }}>
              <SelectTrigger><SelectValue placeholder="Choose a feature" /></SelectTrigger>
              <SelectContent>{optional.map((f) => <SelectItem key={f.code} value={f.code}>{f.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="For the selected merchants">
            <Select value={mode} onValueChange={(v) => { preview.reset(); setMode(v as typeof mode) }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="on">Always on (exception)</SelectItem><SelectItem value="off">Switched off (exception)</SelectItem><SelectItem value="plan">Follow their plan</SelectItem></SelectContent>
            </Select>
          </Field>
          <Button size="sm" variant="outline" className="w-full" disabled={!code || picked.size === 0 || preview.isPending} onClick={() => preview.mutate()}>
            {preview.isPending && <Spinner />} Preview {picked.size} merchant{picked.size === 1 ? '' : 's'}
          </Button>
          {preview.data && (
            <div className="space-y-2">
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2 text-xs">
                {preview.data.items.map((i) => (
                  <div key={i.id} className="flex justify-between gap-2">
                    <span className="truncate">#{i.number} {i.name}</span>
                    {i.allowed ? <Badge variant={ENTITLEMENT[i.now].variant}>now: {ENTITLEMENT[i.now].label}</Badge> : <Badge variant="danger">not yours — skipped</Badge>}
                  </div>
                ))}
              </div>
              <Field label="Reason" required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <Button size="sm" className="w-full" disabled={reason.trim().length < 3 || apply.isPending} onClick={() => apply.mutate()}>
                {apply.isPending && <Spinner />} Apply to {preview.data.items.filter((i) => i.allowed).length}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default function FeaturesPage() {
  const { can } = usePlatform()
  const [state, update] = useUrlState({ tab: 'catalogue' })
  return (
    <div className="space-y-4">
      <PageHeader title="Features & Access" description="Which features exist, who gets them, and the exceptions. Every switch is enforced by the backend, not just hidden in the app." />
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
        <TabsList>
          <TabsTrigger value="catalogue">Features</TabsTrigger>
          {can('features', 'edit') && <TabsTrigger value="bulk">Merchant exceptions</TabsTrigger>}
          {can('settings') && <TabsTrigger value="history">Change history</TabsTrigger>}
        </TabsList>
        <TabsContent value="catalogue"><Catalogue /></TabsContent>
        {can('features', 'edit') && <TabsContent value="bulk"><Bulk /></TabsContent>}
        {can('settings') && <TabsContent value="history"><ConfigHistory /></TabsContent>}
      </Tabs>
    </div>
  )
}
