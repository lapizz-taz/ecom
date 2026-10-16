import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, KeyRound, LogOut, ShieldAlert, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/common/stat-card'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePlatform } from '@/features/platform/platform-context'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { type Approval, decideApproval, listApprovals, listPlatformAudit } from '@/services/platform'
import { type SecurityOverview, securityOverview, signOutStaff, type StaffAccess } from '@/services/platform-data'

const STATUS = { PENDING: 'warning', EXECUTED: 'success', REJECTED: 'neutral', FAILED: 'danger', CANCELLED: 'neutral', EXPIRED: 'neutral' } as const

function Approvals() {
  const queryClient = useQueryClient()
  const { refresh } = usePlatform()
  const [status, setStatus] = useState('PENDING')
  const [deciding, setDeciding] = useState<{ approval: Approval; approve: boolean } | null>(null)
  const list = useQuery({ queryKey: ['platform-approvals', status], queryFn: () => listApprovals(status === 'ALL' ? null : status) })
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {['PENDING', 'EXECUTED', 'REJECTED', 'FAILED', 'CANCELLED', 'EXPIRED', 'ALL'].map((s) => <SelectItem key={s} value={s}>{s === 'ALL' ? 'All (90 days)' : s.toLowerCase()}</SelectItem>)}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Sensitive changes wait here until a second person with approval rights confirms. Nobody approves their own request.</p>
      </div>
      {list.error ? <ErrorState error={list.error} /> : !list.data ? <LoadingState /> : list.data.length === 0 ? <EmptyState title="Nothing here" /> : list.data.map((a) => (
        <Card key={a.id} className="gap-2 px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium">{a.summary}</p>
              <p className="text-xs text-muted-foreground">
                {a.requested_by?.name ?? 'someone'} asked {timeAgo(a.requested_at)}
                {a.merchant && <> · <Link className="underline" to={`/super-admin/merchants/${a.merchant.id}`}>#{a.merchant.number} {a.merchant.name}</Link></>}
                {a.status === 'PENDING' && ` · expires ${formatDateTime(a.expires_at)}`}
              </p>
              <p className="mt-1 text-sm">“{a.reason}”</p>
              {a.decided_by && <p className="mt-1 text-xs text-muted-foreground">{a.status.toLowerCase()} by {a.decided_by.name} {a.decided_at && timeAgo(a.decided_at)}{a.decision_note && ` — ${a.decision_note}`}</p>}
              {a.error && <p className="mt-1 text-xs text-red-500">{a.error}</p>}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={STATUS[a.status]}>{a.status.toLowerCase()}</Badge>
              {a.can_decide && <>
                <Button size="sm" onClick={() => setDeciding({ approval: a, approve: true })}><Check /> Approve</Button>
                {!a.mine && <Button size="sm" variant="outline" onClick={() => setDeciding({ approval: a, approve: false })}><X /> Reject</Button>}
              </>}
              {a.mine && a.status === 'PENDING' && <Button size="sm" variant="ghost" onClick={() => setDeciding({ approval: a, approve: false })}>Withdraw</Button>}
            </div>
          </div>
        </Card>
      ))}
      {deciding && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeciding(null)} reason reasonLabel="Note (optional)"
          title={deciding.approve ? `Approve: ${deciding.approval.summary}?` : deciding.approval.mine ? 'Withdraw your request?' : `Reject: ${deciding.approval.summary}?`}
          description={deciding.approve ? 'It runs straight away, recorded under your name.' : undefined}
          destructive={!deciding.approve} confirmLabel={deciding.approve ? 'Approve and run' : deciding.approval.mine ? 'Withdraw' : 'Reject'}
          onConfirm={async (note) => {
            try {
              const r = await decideApproval(deciding.approval.id, deciding.approve, note || undefined)
              if (r.status === 'FAILED') toast.error(`Approved, but it could not run: ${r.error}`)
              else toast.success(r.status === 'EXECUTED' ? 'Approved and done' : r.status.toLowerCase())
              void queryClient.invalidateQueries({ queryKey: ['platform-approvals'] })
              refresh()
            } catch (e) {
              toast.error((e as Error).message)
              throw e
            }
          }} />
      )}
    </div>
  )
}

function Refusals() {
  const list = useQuery({ queryKey: ['platform-audit', 'denied'], queryFn: () => listPlatformAudit({ result: 'DENIED' }, 1, 100) })
  if (list.error) return <ErrorState error={list.error} />
  if (!list.data) return <LoadingState />
  if (!list.data.items.length) return <EmptyState title="No refused attempts recorded" />
  return (
    <Card className="gap-0 py-0">
      {list.data.items.map((r) => (
        <div key={r.id} className="flex flex-wrap justify-between gap-2 border-b px-4 py-2 text-sm last:border-0">
          <span><code className="text-xs">{r.action}</code> <span className="text-muted-foreground">by {r.actor_email ?? 'unknown'}</span></span>
          <span className="text-xs text-muted-foreground">{formatDateTime(r.created_at)}</span>
        </div>
      ))}
    </Card>
  )
}

// Platform credentials by key prefix: what they are and where they are rotated.
function credentialLabel(key: string): { label: string; to?: string } {
  if (key.startsWith('sms')) return { label: 'Platform SMS provider', to: '/super-admin/sms' }
  if (key.includes('bd_courier') || key.includes('courier_history')) return { label: 'BD Courier', to: '/super-admin/bd-courier' }
  if (key.startsWith('billing') || key.includes('gateway.')) return { label: 'Payments to the platform', to: '/super-admin/subscriptions?tab=payments' }
  if (key.startsWith('voicedrive.trunk')) return { label: 'PBX trunk password (one merchant)', to: '/super-admin/pbx' }
  if (key.startsWith('voicedrive')) return { label: key.endsWith('turn') ? 'PBX TURN secret' : 'PBX gateway token', to: '/super-admin/pbx?tab=gateway' }
  return { label: key }
}

function AccessReview({ d }: { d: SecurityOverview }) {
  const queryClient = useQueryClient()
  const [target, setTarget] = useState<StaffAccess | null>(null)
  const hours = d.settings.staff_session_hours
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {hours ? `Staff sign in again after ${hours} hours` : 'No session limit is set'} — change it under <Link className="underline" to="/super-admin/settings">Global Settings</Link>.
        Second factors (authenticator apps) are counted where staff have set them up; the app does not offer setting one up yet.
      </p>
      <Card className="gap-0 overflow-hidden py-0">
        <div className="overflow-x-auto"><Table>
          <TableHeader><TableRow><TableHead>Employee</TableHead><TableHead>Role</TableHead><TableHead>Last sign-in</TableHead><TableHead className="text-right">Open sessions</TableHead>
            <TableHead>Second factor</TableHead><TableHead>Last action</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>{d.staff.map((s) => (
            <TableRow key={s.user_id} className={s.active ? '' : 'opacity-60'}>
              <TableCell className="text-sm"><p className="font-medium">{s.name}</p><p className="text-xs text-muted-foreground">{s.email}{!s.active && ' · switched off'}</p></TableCell>
              <TableCell className="text-xs">{s.role.name} {s.privileged && <Badge variant="warning" className="ml-1 text-[10px]">privileged</Badge>}
                <p className="text-muted-foreground">{s.scope === 'ALL' ? 'all merchants' : 'assigned merchants'}</p></TableCell>
              <TableCell className="text-xs">{s.last_sign_in_at ? timeAgo(s.last_sign_in_at) : 'never'}</TableCell>
              <TableCell className="text-right text-xs tabular-nums">{s.sessions}{s.oldest_session_at && <p className="text-muted-foreground">oldest {timeAgo(s.oldest_session_at)}</p>}</TableCell>
              <TableCell>{s.second_factors > 0 ? <Badge variant="success">set up</Badge> : <Badge variant={s.privileged ? 'warning' : 'neutral'}>none</Badge>}</TableCell>
              <TableCell className="text-xs">{s.last_action_at ? timeAgo(s.last_action_at) : '—'}{s.denied_7d > 0 && <p className="text-red-500">{s.denied_7d} refused in 7 days</p>}</TableCell>
              <TableCell className="text-right">{d.can.manage && s.sessions > 0 && (
                <Button size="sm" variant="outline" onClick={() => setTarget(s)}><LogOut /> Sign out everywhere</Button>)}</TableCell>
            </TableRow>))}</TableBody>
        </Table></div>
      </Card>
      {target && (
        <ConfirmDialog open onOpenChange={(o) => !o && setTarget(null)} title={`Sign ${target.name} out on every device?`} confirmLabel="Sign out" destructive
          description="Their open sessions end now; the panel stops answering them until they sign in again. Their account stays active (switch it off under Employees & Roles if needed)."
          reason reasonRequired reasonLabel="Why (kept in the audit log)"
          onConfirm={async (reason) => {
            const r = await signOutStaff(target.user_id, reason)
            toast.success(`${r.sessions_ended} session(s) ended`)
            void queryClient.invalidateQueries({ queryKey: ['platform-security'] })
          }} />
      )}
    </div>
  )
}

function Credentials({ d }: { d: SecurityOverview }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">The platform's own provider credentials, kept encrypted in the vault. Only a masked hint is ever shown. Rotate a credential on its page; merchants' own store and courier credentials stay with each merchant and are not listed here.</p>
      <Card className="gap-0 overflow-hidden py-0">
        {d.credentials.length === 0 ? <EmptyState icon={<KeyRound />} title="No platform credentials stored" /> : (
          <Table>
            <TableHeader><TableRow><TableHead>Credential</TableHead><TableHead>Hint</TableHead><TableHead>Last set</TableHead><TableHead>By</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{d.credentials.map((c) => {
              const l = credentialLabel(c.key)
              return (
                <TableRow key={c.key}>
                  <TableCell className="text-sm">{l.label}<p className="font-mono text-[11px] text-muted-foreground">{c.key}</p></TableCell>
                  <TableCell className="font-mono text-xs">{c.hint ?? '—'}</TableCell>
                  <TableCell className="text-xs">{timeAgo(c.updated_at)}{c.age_days > 180 && <Badge variant="warning" className="ml-1 text-[10px]">over 6 months</Badge>}</TableCell>
                  <TableCell className="text-xs">{c.updated_by ?? '—'}</TableCell>
                  <TableCell className="text-right">{l.to && <Button size="sm" variant="ghost" asChild><Link to={l.to}>Rotate</Link></Button>}</TableCell>
                </TableRow>
              )
            })}</TableBody>
          </Table>
        )}
      </Card>
    </div>
  )
}

function Sensitive({ d }: { d: SecurityOverview }) {
  if (!d.sensitive.length) return <EmptyState title="No sensitive actions recorded" />
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <Table>
        <TableHeader><TableRow><TableHead>When</TableHead><TableHead>What</TableHead><TableHead>Who</TableHead><TableHead>Merchant</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader>
        <TableBody>{d.sensitive.map((a) => (
          <TableRow key={a.id}>
            <TableCell className="text-xs whitespace-nowrap">{formatDateTime(a.created_at)}</TableCell>
            <TableCell className="text-xs"><code>{a.action}</code>{a.result !== 'SUCCESS' && <Badge variant={a.result === 'DENIED' ? 'danger' : 'neutral'} className="ml-1 text-[10px]">{a.result.toLowerCase()}</Badge>}</TableCell>
            <TableCell className="text-xs">{a.actor ?? 'system'}</TableCell>
            <TableCell className="text-xs">{a.merchant ? <Link className="hover:underline" to={`/super-admin/merchants/${a.merchant.id}`}>#{a.merchant.number} {a.merchant.name}</Link> : '—'}</TableCell>
            <TableCell className="max-w-xs text-xs whitespace-normal text-muted-foreground">{a.reason ?? '—'}</TableCell>
          </TableRow>))}</TableBody>
      </Table>
    </Card>
  )
}

export default function SecurityPage() {
  const [state, update] = useUrlState({ tab: 'access' })
  const { can } = usePlatform()
  const q = useQuery({ queryKey: ['platform-security'], queryFn: securityOverview })
  const d = q.data
  const noSecond = d?.staff.filter((s) => s.active && s.privileged && s.second_factors === 0).length ?? 0
  return (
    <div className="space-y-4">
      <PageHeader title="Security Center" description="Who has access and how they sign in, the platform's credentials, second-person approvals and refused attempts. Every entry is also in the Audit Logs." />
      {d && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Active staff" value={d.staff.filter((s) => s.active).length} hint={`${d.staff.filter((s) => s.active && s.privileged).length} privileged`} />
          <StatCard label="Privileged without a second factor" value={noSecond} tone={noSecond ? 'warning' : 'positive'} icon={<ShieldAlert />} />
          <StatCard label="Refused in 24 h" value={d.counts.denied_24h} tone={d.counts.denied_24h ? 'warning' : 'default'} />
          <StatCard label="Waiting for approval" value={d.counts.pending_approvals} hint={`${d.counts.support_sessions_open} customer-view session(s) open`} />
        </div>
      )}
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
        <TabsList>
          <TabsTrigger value="access">Access review</TabsTrigger>
          <TabsTrigger value="credentials">Credentials</TabsTrigger>
          <TabsTrigger value="sensitive">Sensitive actions</TabsTrigger>
          <TabsTrigger value="approvals">Approvals</TabsTrigger>
          {can('audit') && <TabsTrigger value="refused">Refused attempts</TabsTrigger>}
        </TabsList>
        {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d ? <LoadingState /> : (
          <>
            <TabsContent value="access" className="mt-3"><AccessReview d={d} /></TabsContent>
            <TabsContent value="credentials" className="mt-3"><Credentials d={d} /></TabsContent>
            <TabsContent value="sensitive" className="mt-3"><Sensitive d={d} /></TabsContent>
          </>
        )}
        <TabsContent value="approvals"><Approvals /></TabsContent>
        {can('audit') && <TabsContent value="refused"><Refusals /></TabsContent>}
      </Tabs>
    </div>
  )
}
