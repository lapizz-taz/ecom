import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { usePlatform } from '@/features/platform/platform-context'
import { formatDateTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { type ConfigVersion, configHistory, rollbackConfig } from '@/services/billing'

const KIND_LABEL: Record<string, string> = { plan: 'Plan', feature: 'Feature', merchant_feature: 'Merchant feature', access_rules: 'Access rules', platform_setting: 'Setting', automation_rule: 'Automation' }

/** Configuration history: every version of plans, features and settings. Money and orders are never rolled back here. */
export function ConfigHistory() {
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const [kind, setKind] = useState('all')
  const list = useQuery({ queryKey: ['platform-config-history', kind], queryFn: () => configHistory(kind === 'all' ? null : kind, null, 200) })
  const [rolling, setRolling] = useState<ConfigVersion | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">Everything</SelectItem>{Object.entries(KIND_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Restoring a version changes configuration only. Invoices, payments, credits and orders are never rolled back.</p>
      </div>
      <Card className="gap-0 py-0">
        {list.error ? <ErrorState error={list.error} /> : !list.data ? <LoadingState /> : list.data.length === 0 ? <EmptyState title="No changes recorded yet" /> : list.data.map((v) => (
          <div key={v.id} className="border-b px-4 py-2 text-sm last:border-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button type="button" className="min-w-0 text-left" onClick={() => setOpen(open === v.id ? null : v.id)}>
                <Badge variant="neutral">{KIND_LABEL[v.kind] ?? v.kind}</Badge> <span className="font-medium">{String(v.data?.name ?? v.ref)}</span>
                <span className="block text-xs text-muted-foreground">v{v.id} · {v.changed_by ?? 'system'} · {formatDateTime(v.changed_at)}{v.note && ` · “${v.note}”`}</span>
              </button>
              {can('settings', 'edit') && <Button size="sm" variant="ghost" onClick={() => setRolling(v)}><RotateCcw /> Restore</Button>}
            </div>
            {open === v.id && <pre className="mt-2 max-h-56 overflow-auto rounded bg-muted/40 p-2 text-xs whitespace-pre-wrap">{JSON.stringify(v.data, null, 1)}</pre>}
          </div>
        ))}
      </Card>
      {rolling && (
        <ConfirmDialog open onOpenChange={(o) => !o && setRolling(null)} reason reasonRequired confirmLabel="Restore this version"
          title={`Restore version ${rolling.id} of ${KIND_LABEL[rolling.kind] ?? rolling.kind} “${String(rolling.data?.name ?? rolling.ref)}”?`}
          description="It is saved as a new version (nothing is deleted from the history). For a plan, only future invoices use the restored prices and limits."
          onConfirm={async (reason) => {
            try {
              await rollbackConfig(rolling.id, reason)
              toast.success('Restored')
              void queryClient.invalidateQueries({ queryKey: ['platform-config-history'] })
              void queryClient.invalidateQueries({ queryKey: ['platform-plans'] })
              void queryClient.invalidateQueries({ queryKey: ['platform-settings'] })
              void queryClient.invalidateQueries({ queryKey: ['platform-global-settings'] })
              void queryClient.invalidateQueries({ queryKey: ['platform-automation'] })
            } catch (e) {
              toast.error((e as Error).message)
              throw e
            }
          }} />
      )}
    </div>
  )
}
