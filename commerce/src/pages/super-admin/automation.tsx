import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FlaskConical, Pencil, Play, Plus, Trash2, Workflow } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, ErrorState, Spinner, TableSkeleton } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useUrlState } from '@/hooks/use-url-state'
import { formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  ANNOUNCEMENT_KINDS, type AnnouncementKind, archiveAutomationRule, type AutomationAction, type AutomationActionType, type AutomationDryRun,
  type AutomationRule, type AutomationRules, type AutomationTrigger, listAutomationRules, listAutomationRuns, runAutomationRule, saveAutomationRule,
  testAutomationRule,
} from '@/services/platform-ops'

const CONDITION_LABEL: Record<string, string> = {
  min_errors: 'At least this many errors', hours: 'Within the last (hours)', days: 'Days', min_refused: 'At least this many refused requests',
  max_level: 'Escalate up to level', minutes: 'Window (minutes)',
}
const ACTION_LABEL: Record<AutomationActionType, string> = {
  notify_staff: 'Notify platform staff', notify_account_manager: "Notify the merchant's account manager", escalate_ticket: 'Escalate the ticket',
  create_incident: 'Open an incident', notify_merchant: 'Send the merchant an in-app message',
}
const ACCESS_LABEL: Record<string, string> = { view: 'can view', create: 'can create', edit: 'can edit', delete: 'can delete', manage: 'can manage', export: 'can export', approve: 'can approve' }
const CONDITION_SHORT: Record<string, string> = {
  min_errors: 'at least {v} errors', hours: 'in {v} h', days: 'after {v} days', min_refused: 'at least {v} refused', max_level: 'up to level {v}', minutes: 'over {v} min',
}
const conditionsText = (c: Record<string, number>) => Object.entries(c).map(([k, v]) => (CONDITION_SHORT[k] ?? `${k} {v}`).replace('{v}', String(v))).join(', ')
function cooldownText(m: number) {
  if (m < 60) return `${m} min`
  if (m < 1440) return `${Math.round(m / 6) / 10} h`
  const days = Math.round(m / 144) / 10
  return `${days} day${days === 1 ? '' : 's'}`
}

function actionText(a: AutomationAction, rules: AutomationRules) {
  if (a.type === 'notify_staff') {
    const mod = rules.modules.find((m) => m.code === (a.module ?? 'health'))?.name ?? a.module
    return `Notify staff who ${ACCESS_LABEL[a.action ?? 'view'] ?? a.action} ${mod}`
  }
  if (a.type === 'notify_merchant') return `Message the merchant: “${a.title ?? '…'}”`
  if (a.type === 'create_incident') return `Open a ${(a.severity ?? 'HIGH').toLowerCase()} incident`
  return ACTION_LABEL[a.type]
}

function DryRunResult({ r }: { r: AutomationDryRun }) {
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm" aria-live="polite">
      <p><strong>{formatNumber(r.matches)}</strong> match right now · <strong>{formatNumber(r.would_act)}</strong> would be acted on in the next run (others are in cooldown or over the per-run limit). Nothing was changed.</p>
      {r.subjects.length > 0 && (
        <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
          {r.subjects.map((s) => (
            <li key={s.key} className={cn(s.in_cooldown && 'text-muted-foreground')}>
              • {s.title}{s.detail && <span className="text-muted-foreground"> — {s.detail}</span>}{s.in_cooldown && ' (in cooldown)'}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type Draft = { id?: string; name: string; description: string; trigger: AutomationTrigger; conditions: Record<string, number>; actions: AutomationAction[]
  enabled: boolean; cooldown_minutes: number; max_actions_per_run: number }

function RuleEditor({ rules, rule, onClose }: { rules: AutomationRules; rule: AutomationRule | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const first: AutomationTrigger = 'integration_failures' in rules.catalog ? 'integration_failures' : (Object.keys(rules.catalog) as AutomationTrigger[])[0]
  const [d, setD] = useState<Draft>(rule ? { id: rule.id, name: rule.name, description: rule.description ?? '', trigger: rule.trigger, conditions: rule.conditions,
    actions: rule.actions, enabled: rule.enabled, cooldown_minutes: rule.cooldown_minutes, max_actions_per_run: rule.max_actions_per_run }
    : { name: '', description: '', trigger: first, conditions: {}, actions: [], enabled: false, cooldown_minutes: 1440, max_actions_per_run: 25 })
  const [reason, setReason] = useState('')
  const cat = rules.catalog[d.trigger]
  const payload = () => ({ ...d, description: d.description.trim() || null, name: d.name.trim() })
  const test = useMutation({ meta: { silent: true }, mutationFn: () => testAutomationRule(payload()) })
  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => saveAutomationRule(payload(), reason.trim() || undefined),
    onSuccess: () => { toast.success('Rule saved'); void queryClient.invalidateQueries({ queryKey: ['platform-automation'] }); onClose() },
  })
  const setAction = (i: number, patch: Partial<AutomationAction>) => setD({ ...d, actions: d.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) })
  const addAction = (type: AutomationActionType) => setD({ ...d, actions: [...d.actions, type === 'notify_staff' ? { type, module: 'health', action: 'view', severity: 'WARN' }
    : type === 'notify_merchant' ? { type, kind: 'GENERAL', severity: 'INFO', title: '', body: '' } : type === 'create_incident' ? { type, severity: 'HIGH' } : { type }] })
  const valid = d.name.trim().length >= 3 && d.actions.length > 0 && d.actions.every((a) => a.type !== 'notify_merchant' || ((a.title ?? '').trim().length >= 3 && (a.body ?? '').trim().length >= 3))
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rule ? 'Edit rule' : 'New rule'}</DialogTitle>
          <DialogDescription>Rules read the platform's own records (logs, tickets, billing, usage) — never notifications, incidents or messages — so one rule cannot set off another.</DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-4">
          <Field label="Name" required><Input value={d.name} maxLength={100} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
          <Field label="When" hint={cat.help}>
            <Select value={d.trigger} disabled={!!rule} onValueChange={(t) => setD({ ...d, trigger: t as AutomationTrigger, conditions: {}, actions: [] })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.entries(rules.catalog) as Array<[AutomationTrigger, AutomationRules['catalog'][AutomationTrigger]]>).map(([k, v]) =>
                <SelectItem key={k} value={k}>{v.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {Object.keys(cat.conditions).length > 0 && (
            <div className="grid gap-3 sm:grid-cols-3">
              {Object.entries(cat.conditions).map(([k, def]) => (
                <Field key={k} label={CONDITION_LABEL[k] ?? k}>
                  <Input type="number" min={0} value={d.conditions[k] ?? def}
                    onChange={(e) => setD({ ...d, conditions: { ...d.conditions, [k]: Number(e.target.value) } })} />
                </Field>
              ))}
            </div>
          )}
          <div className="space-y-2">
            <p className="text-sm font-medium">Then</p>
            {d.actions.map((a, i) => (
              <div key={i} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{ACTION_LABEL[a.type]}</span>
                  <Button size="sm" variant="ghost" aria-label="Remove action" onClick={() => setD({ ...d, actions: d.actions.filter((_, j) => j !== i) })}><Trash2 /></Button></div>
                {a.type === 'notify_staff' && (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <Field label="Section">
                      <Select value={a.module ?? 'health'} onValueChange={(module) => setAction(i, { module, action: rules.modules.find((m) => m.code === module)?.actions[0] ?? 'view' })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{rules.modules.map((m) => <SelectItem key={m.code} value={m.code}>{m.name}</SelectItem>)}</SelectContent>
                      </Select>
                    </Field>
                    <Field label="People who">
                      <Select value={a.action ?? 'view'} onValueChange={(action) => setAction(i, { action })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{(rules.modules.find((m) => m.code === (a.module ?? 'health'))?.actions ?? ['view']).map((x) => <SelectItem key={x} value={x}>{ACCESS_LABEL[x] ?? x}</SelectItem>)}</SelectContent>
                      </Select>
                    </Field>
                    <Field label="Importance">
                      <Select value={a.severity ?? 'WARN'} onValueChange={(severity) => setAction(i, { severity })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="INFO">Information</SelectItem><SelectItem value="WARN">Warning</SelectItem><SelectItem value="CRITICAL">Critical</SelectItem></SelectContent>
                      </Select>
                    </Field>
                  </div>
                )}
                {a.type === 'create_incident' && (
                  <Field label="Severity">
                    <Select value={a.severity ?? 'HIGH'} onValueChange={(severity) => setAction(i, { severity })}>
                      <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                      <SelectContent>{['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => <SelectItem key={s} value={s}>{s.toLowerCase()}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                )}
                {a.type === 'notify_merchant' && (
                  <div className="grid gap-2">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Field label="Kind">
                        <Select value={a.kind ?? 'GENERAL'} onValueChange={(kind) => setAction(i, { kind: kind as AnnouncementKind })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>{ANNOUNCEMENT_KINDS.map((k) => <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>)}</SelectContent>
                        </Select>
                      </Field>
                      <Field label="Link (optional)"><Input value={a.link ?? ''} placeholder="/admin/…" onChange={(e) => setAction(i, { link: e.target.value })} /></Field>
                    </div>
                    <Field label="Title"><Input value={a.title ?? ''} maxLength={140} onChange={(e) => setAction(i, { title: e.target.value })} /></Field>
                    <Field label="Message"><Textarea rows={2} value={a.body ?? ''} onChange={(e) => setAction(i, { body: e.target.value })} /></Field>
                  </div>
                )}
              </div>
            ))}
            <div className="flex flex-wrap gap-1.5">
              {cat.actions.filter((t) => t === 'notify_staff' || !d.actions.some((a) => a.type === t)).map((t) => (
                <Button key={t} size="sm" variant="outline" onClick={() => addAction(t)}><Plus /> {ACTION_LABEL[t]}</Button>
              ))}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Act on the same subject at most once every (minutes)" hint={`Now: ${cooldownText(d.cooldown_minutes)} · 10 minutes to 30 days`}>
              <Input type="number" min={10} max={43200} value={d.cooldown_minutes} onChange={(e) => setD({ ...d, cooldown_minutes: Number(e.target.value) })} />
            </Field>
            <Field label="At most this many subjects per run" hint="The rest wait for the next run (every 10 minutes).">
              <Input type="number" min={1} max={200} value={d.max_actions_per_run} onChange={(e) => setD({ ...d, max_actions_per_run: Number(e.target.value) })} />
            </Field>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
            <span>Switched on<span className="block text-xs text-muted-foreground">{rules.can.manage ? 'Runs by itself every 10 minutes.' : 'Only staff with manage access can switch rules on or off.'}</span></span>
            <Switch checked={d.enabled} disabled={!rules.can.manage} onCheckedChange={(enabled) => setD({ ...d, enabled })} />
          </label>
          {rule && <Field label="Why the change (for the audit log)"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
          {test.data && <DryRunResult r={test.data} />}
          {(test.error || save.error) && <p className="rounded-md bg-red-500/10 p-3 text-sm text-red-500" role="alert">{((save.error ?? test.error) as Error).message}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button variant="outline" disabled={!valid || test.isPending} onClick={() => test.mutate()}>{test.isPending ? <Spinner /> : <FlaskConical />} Test (changes nothing)</Button>
          <Button disabled={!valid || save.isPending} onClick={() => save.mutate()}>{save.isPending && <Spinner />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RunsLog({ ruleId }: { ruleId: string | null }) {
  const q = useQuery({ queryKey: ['platform-automation', 'runs', ruleId], queryFn: () => listAutomationRuns(ruleId) })
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  if (!q.data) return <TableSkeleton rows={5} cols={5} />
  if (q.data.length === 0) return <EmptyState title="No actions yet" description="Every action a rule takes is recorded here and cannot be changed." />
  return (
    <div className="overflow-x-auto"><Table>
      <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Rule</TableHead><TableHead>About</TableHead><TableHead>Result</TableHead><TableHead>What was done</TableHead></TableRow></TableHeader>
      <TableBody>{q.data.map((r) => (
        <TableRow key={r.id}>
          <TableCell className="text-xs whitespace-nowrap">{timeAgo(r.created_at)}{r.manual && <Badge variant="neutral" className="ml-1 text-[10px]">run now</Badge>}</TableCell>
          <TableCell className="text-xs">{r.rule.name}</TableCell>
          <TableCell className="max-w-xs text-xs"><p className="truncate">{r.title ?? r.subject}</p>
            {r.merchant && <Link className="text-muted-foreground underline" to={`/super-admin/merchants/${r.merchant.id}`}>#{r.merchant.number} {r.merchant.name}</Link>}</TableCell>
          <TableCell><Badge variant={r.status === 'ACTED' ? 'success' : 'danger'}>{r.status === 'ACTED' ? 'done' : 'failed'}</Badge></TableCell>
          <TableCell className="max-w-sm text-xs whitespace-normal text-muted-foreground">{r.error ?? r.actions.map((a) => {
            const x = a as Record<string, unknown>
            return x.type === 'notify_staff' || x.type === 'notify_account_manager' ? `${x.notified} notified`
              : x.type === 'escalate_ticket' ? `escalated to level ${x.level}` : x.type === 'create_incident' ? `incident #${x.incident}`
              : x.type === 'notify_merchant' ? `message #${x.announcement}` : String(x.type)
          }).join(' · ')}</TableCell>
        </TableRow>))}</TableBody>
    </Table></div>
  )
}

export default function AutomationPage() {
  const queryClient = useQueryClient()
  const [state, setState] = useUrlState({ tab: 'rules', rule: '' })
  const [editing, setEditing] = useState<AutomationRule | 'new' | null>(null)
  const [testing, setTesting] = useState<{ rule: AutomationRule; result?: AutomationDryRun } | null>(null)
  const [removing, setRemoving] = useState<AutomationRule | null>(null)
  const q = useQuery({ queryKey: ['platform-automation'], queryFn: listAutomationRules })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['platform-automation'] })
  const toggle = useMutation({
    mutationFn: (r: AutomationRule) => saveAutomationRule({ id: r.id, name: r.name, description: r.description, trigger: r.trigger, conditions: r.conditions, actions: r.actions,
      enabled: !r.enabled, cooldown_minutes: r.cooldown_minutes, max_actions_per_run: r.max_actions_per_run }),
    onSuccess: (r) => { toast.success(r.enabled ? 'Switched on' : 'Switched off'); void refresh() },
  })
  const run = useMutation({
    mutationFn: (r: AutomationRule) => runAutomationRule(r.id),
    onSuccess: (out) => {
      const x = out[0]
      toast.success(x ? `${x.acted} acted on, ${x.skipped} skipped${x.failed ? `, ${x.failed} failed` : ''}` : 'Nothing to do')
      void refresh()
    },
  })
  const dry = useMutation({ mutationFn: (r: AutomationRule) => testAutomationRule({ id: r.id }), onSuccess: (result, rule) => setTesting({ rule, result }) })
  const d = q.data
  return (
    <div className="space-y-4">
      <PageHeader title="Automation Rules" description="Rules that watch for problems and act — notify staff, escalate tickets, open incidents or message merchants. Each subject is handled at most once per cooldown, runs are capped, and every action is logged."
        actions={d?.can.create && <Button onClick={() => setEditing('new')}><Plus /> New rule</Button>} />
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <Tabs value={state.tab} onValueChange={(tab) => setState({ tab })}>
          <TabsList><TabsTrigger value="rules">Rules</TabsTrigger><TabsTrigger value="log">Action log</TabsTrigger></TabsList>
          <TabsContent value="rules" className="mt-3">
            <Card className="gap-0 overflow-hidden py-0">
              {!d ? <TableSkeleton rows={5} cols={5} /> : d.rules.length === 0 ? <EmptyState icon={<Workflow />} title="No rules" /> : (
                <div className="divide-y">
                  {d.rules.map((r) => (
                    <div key={r.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium">{r.name}</p>
                          <Badge variant={r.enabled ? 'success' : 'neutral'}>{r.enabled ? 'On' : 'Off'}</Badge>
                          {r.failed_7d > 0 && <Badge variant="danger">{r.failed_7d} failed in 7 days</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground">When: {d.catalog[r.trigger]?.name}
                          {Object.entries(r.conditions).length > 0 && ` — ${conditionsText(r.conditions)}`}</p>
                        <p className="text-xs text-muted-foreground">Then: {r.actions.map((a) => actionText(a, d)).join(' · ')}</p>
                        <p className="text-xs text-muted-foreground/80">Once per {cooldownText(r.cooldown_minutes)} per subject · up to {r.max_actions_per_run} per run · {formatNumber(r.runs_7d)} action(s) in 7 days
                          {r.last_run_at && ` · last run ${timeAgo(r.last_run_at)}${r.last_result ? ` (${r.last_result.acted} acted, ${r.last_result.skipped} skipped)` : ''}`}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {d.can.manage && <Switch checked={r.enabled} disabled={toggle.isPending} onCheckedChange={() => toggle.mutate(r)} aria-label={`${r.name} on or off`} />}
                        <Button size="sm" variant="outline" disabled={dry.isPending} onClick={() => dry.mutate(r)}><FlaskConical /> Test</Button>
                        {d.can.manage && <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate(r)}><Play /> Run now</Button>}
                        {d.can.edit && <Button size="sm" variant="ghost" aria-label="Edit" onClick={() => setEditing(r)}><Pencil /></Button>}
                        <Button size="sm" variant="ghost" onClick={() => setState({ tab: 'log', rule: r.id })}>Log</Button>
                        {d.can.delete && <Button size="sm" variant="ghost" aria-label="Remove" onClick={() => setRemoving(r)}><Trash2 /></Button>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </TabsContent>
          <TabsContent value="log" className="mt-3">
            {state.rule && d && (
              <p className="mb-2 text-xs text-muted-foreground">Showing {d.rules.find((r) => r.id === state.rule)?.name ?? 'one rule'} · <button type="button" className="underline" onClick={() => setState({ rule: '' })}>show all</button></p>
            )}
            <Card className="gap-0 overflow-hidden py-0"><RunsLog ruleId={state.rule || null} /></Card>
          </TabsContent>
        </Tabs>
      )}
      {editing && d && <RuleEditor rules={d} rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {testing?.result && (
        <ConfirmDialog open onOpenChange={(o) => !o && setTesting(null)} title={`Test: ${testing.rule.name}`} confirmLabel="Close" onConfirm={() => setTesting(null)}>
          <DryRunResult r={testing.result} />
        </ConfirmDialog>
      )}
      {removing && (
        <ConfirmDialog open onOpenChange={(o) => !o && setRemoving(null)} title={`Remove “${removing.name}”?`} destructive confirmLabel="Remove"
          description="It is switched off and hidden; its action log is kept." reason reasonRequired reasonLabel="Why (at least 5 characters)"
          onConfirm={async (reason) => { await archiveAutomationRule(removing.id, reason); toast.success('Removed'); void refresh() }} />
      )}
    </div>
  )
}
