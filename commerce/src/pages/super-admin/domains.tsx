import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Globe2, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { type Column, DataTable } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { SearchInput } from '@/components/common/search-input'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { DomainChip, DomainDetail } from '@/features/website/domain-status'
import { useUrlState } from '@/hooks/use-url-state'
import { toUserMessage } from '@/lib/errors'
import { formatDate, formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { type DomainBucket, listPlatformDomains, type PlatformDomain, platformCheckDomain, platformRemoveDomain } from '@/services/platform-domains'

const FILTERS: Array<{ value: '' | DomainBucket; label: string }> = [
  { value: '', label: 'All' },
  { value: 'ISSUES', label: 'Issues' },
  { value: 'WAITING', label: 'Waiting' },
  { value: 'LIVE', label: 'Live' },
  { value: 'MANUAL', label: 'Manual' },
  { value: 'REMOVED', label: 'Removed' },
]

/** Every store's custom domains: where each stands, the last check, and Check again / Remove for a store. */
export default function PlatformDomainsPage() {
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ q: '', bucket: '', open: '' })
  const [removing, setRemoving] = useState<PlatformDomain | null>(null)
  const list = useQuery({
    queryKey: ['platform-domains', state.q, state.bucket],
    placeholderData: keepPreviousData,
    queryFn: () => listPlatformDomains(state.q, state.bucket),
  })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['platform-domains'] })
  const check = useMutation({
    mutationFn: (d: PlatformDomain) => platformCheckDomain(d.merchant.id, d.domain),
    onSuccess: (r, d) => { toast.success(r.domain?.status === 'ACTIVE' ? `${d.domain} is live` : `${d.domain} checked`); refresh() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const counts = list.data?.counts
  const rows = list.data?.domains
  const open = rows?.find((d) => d.id === state.open) ?? null

  const columns: Column<PlatformDomain>[] = [
    {
      key: 'domain', header: 'Domain', primary: true,
      cell: (d) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Globe2 className="size-4" /></span>
          <div className="min-w-0">
            <p className="truncate font-medium">{d.domain}</p>
            <p className="truncate text-xs text-muted-foreground">{d.status === 'REMOVED' ? 'Removed' : d.is_primary ? 'Primary domain' : 'Redirects to primary'}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'store', header: 'Store',
      cell: (d) => (
        <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
          <Link to={`/super-admin/merchants/${d.merchant.id}`} className="font-medium hover:underline">{d.merchant.name}</Link>
          <p className="text-xs text-muted-foreground">#{d.merchant.number}{d.merchant.status !== 'ACTIVE' ? ` · ${d.merchant.status.toLowerCase()}` : ''}</p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', cell: (d) => d.status === 'REMOVED' ? <span className="text-xs text-muted-foreground">Removed</span> : <DomainChip d={d} /> },
    {
      key: 'issues', header: 'Last check', hideOnMobile: true,
      cell: (d) => (
        <div className="text-xs">
          <p className={cn(d.issues ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>{d.issues ? `${formatNumber(d.issues)} issue${d.issues === 1 ? '' : 's'}` : 'No issues'}</p>
          <p className="text-muted-foreground">{d.checked_at ? timeAgo(d.checked_at) : 'Not checked yet'}</p>
        </div>
      ),
    },
    { key: 'added', header: 'Added', hideOnMobile: true, cell: (d) => <span className="text-xs text-muted-foreground">{formatDate(d.created_at)}</span> },
    {
      key: 'actions', header: '', align: 'right',
      cell: (d) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {d.status !== 'REMOVED' && (
            <Button asChild size="icon-sm" variant="ghost" aria-label={`Open ${d.domain}`}>
              <a href={`https://${d.domain}`} target="_blank" rel="noreferrer"><ExternalLink /></a>
            </Button>
          )}
          {d.can_manage && d.status !== 'REMOVED' && (
            <>
              <Button size="icon-sm" variant="ghost" aria-label={`Check ${d.domain} again`} disabled={check.isPending} onClick={() => check.mutate(d)}>
                <RefreshCw className={cn(check.isPending && check.variables?.id === d.id && 'animate-spin')} />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label={`Remove ${d.domain}`} onClick={() => setRemoving(d)}><Trash2 /></Button>
            </>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader title="Domains" description="Every store's custom domain: where it stands, the last check and its issues. Domains are checked by themselves; check one again or remove it for a store here." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Live" value={formatNumber(counts?.LIVE ?? 0)} hint="Open the store with HTTPS" />
        <StatCard label="Waiting" value={formatNumber(counts?.WAITING ?? 0)} hint="For DNS, the TXT record or HTTPS" />
        <StatCard label="Issues" value={formatNumber(counts?.ISSUES ?? 0)} tone={counts?.ISSUES ? 'warning' : 'default'} hint="The last check found a problem" />
        <StatCard label="Stores with a domain" value={formatNumber(list.data?.stores ?? 0)} hint={`${formatNumber(counts?.MANUAL ?? 0)} connected by hand`} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Button key={f.value || 'all'} size="sm" variant={state.bucket === f.value ? 'default' : 'outline'} onClick={() => update({ bucket: f.value })}>
            {f.label}
            <span className="ml-1 tabular-nums opacity-70">{formatNumber(counts?.[f.value || 'ALL'] ?? 0)}</span>
          </Button>
        ))}
        {list.isFetching && <Spinner />}
      </div>
      <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Domain, store name or number" />
      <DataTable columns={columns} rows={rows} rowKey={(d) => d.id} loading={list.isLoading} error={list.error} onRetry={() => list.refetch()}
        onRowClick={(d) => update({ open: d.id }, { resetPage: false })}
        empty={<EmptyState icon={<Globe2 className="size-5" />} title={state.q || state.bucket ? 'No domain matches' : 'No store has a custom domain yet'}
          description={state.q || state.bucket ? 'Try another filter or search.' : 'Stores connect their own domain under Website & domains.'} />} />

      <Dialog open={!!open} onOpenChange={(v) => !v && update({ open: '' }, { resetPage: false })}>
        <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="max-h-[92dvh] gap-0 overflow-x-hidden overflow-y-auto p-0 sm:max-w-2xl">
          <DialogTitle className="sr-only">{open?.domain ?? 'Domain'}</DialogTitle>
          <DialogDescription className="sr-only">Connection status of the domain</DialogDescription>
          {open && (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/30 px-5 py-2.5 pr-12 text-xs">
                <span className="text-muted-foreground">Store</span>
                <Link to={`/super-admin/merchants/${open.merchant.id}`} className="font-medium hover:underline">{open.merchant.name} · #{open.merchant.number}</Link>
                {open.verified_at && <span className="text-muted-foreground">Ownership proven {formatDate(open.verified_at)}</span>}
              </div>
              <DomainDetail inDialog d={open} primary={rows?.find((x) => x.merchant.id === open.merchant.id && x.is_primary && x.status !== 'REMOVED')?.domain ?? null}
                canEdit={open.can_manage && open.status !== 'REMOVED'} canChangeType={false} checking={check.isPending}
                onBack={() => update({ open: '' }, { resetPage: false })} onCheck={() => check.mutate(open)} onRemove={() => setRemoving(open)}
                onMakePrimary={async () => undefined} />
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={!!removing} onOpenChange={(v) => !v && setRemoving(null)} destructive confirmLabel="Remove domain"
        title={`Remove ${removing?.domain ?? ''} from ${removing?.merchant.name ?? 'the store'}?`}
        description="The store stops opening on this domain and it is taken off the hosting. The store can add it again later (it proves ownership again). The reason is kept in the audit log."
        reason reasonRequired reasonLabel="Why is it removed?"
        onConfirm={async (reason) => {
          try {
            await platformRemoveDomain(removing!.merchant.id, removing!.domain, reason)
            toast.success(`${removing!.domain} removed`)
            if (state.open === removing!.id) update({ open: '' }, { resetPage: false })
            refresh()
          } catch (e) { toast.error(toUserMessage(e)); throw e }
        }} />
    </div>
  )
}
