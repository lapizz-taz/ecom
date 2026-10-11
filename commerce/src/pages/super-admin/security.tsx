import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePlatform } from '@/features/platform/platform-context'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { type Approval, decideApproval, listApprovals, listPlatformAudit } from '@/services/platform'

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
                <Button size="sm" variant="outline" onClick={() => setDeciding({ approval: a, approve: false })}><X /> Reject</Button>
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

export default function SecurityPage() {
  const [state, update] = useUrlState({ tab: 'approvals' })
  const { can } = usePlatform()
  return (
    <div className="space-y-4">
      <PageHeader title="Security Center" description="Second-person approvals and refused attempts. Every entry is also in the Audit Logs." />
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
        <TabsList>
          <TabsTrigger value="approvals">Approvals</TabsTrigger>
          {can('audit') && <TabsTrigger value="refused">Refused attempts</TabsTrigger>}
        </TabsList>
        <TabsContent value="approvals"><Approvals /></TabsContent>
        {can('audit') && <TabsContent value="refused"><Refusals /></TabsContent>}
      </Tabs>
    </div>
  )
}
