import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Laptop, MonitorSmartphone, ShieldCheck, Smartphone, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { formatDateTime, timeAgo } from '@/lib/format'
import { approveRecentDevices, decideDevice, DEVICE_STATUS, type DeviceStatus, listDevices, saveDeviceSettings, type StaffDevice } from '@/services/support'

const isPhone = (d: StaffDevice) => /Android|iOS/.test(d.label ?? '') || /Mobile|Android|iPhone/.test(d.user_agent ?? '')

export default function DeviceApprovalsPage() {
  const { can } = useAuth()
  const canManage = can('devices.manage')
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'PENDING' | 'APPROVED' | 'BLOCKED' | 'ALL'>('PENDING')
  const [confirm, setConfirm] = useState<{ device: StaffDevice; action: 'reject' | 'revoke' } | null>(null)
  const [enableOpen, setEnableOpen] = useState(false)
  const q = useQuery({ queryKey: ['devices'], queryFn: listDevices, enabled: canManage, refetchInterval: 30_000 })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['devices'] })
  const decide = useMutation({
    mutationFn: (v: { id: string; action: 'approve' | 'reject' | 'revoke'; note?: string }) => decideDevice(v.id, v.action, v.note),
    onSuccess: (_, v) => { toast.success(v.action === 'approve' ? 'Device approved' : v.action === 'reject' ? 'Device rejected' : 'Device revoked'); refresh() },
  })
  const settings = useMutation({
    mutationFn: saveDeviceSettings,
    onSuccess: (v) => { toast.success(v.enabled ? 'Device approval is on' : 'Device approval is off'); refresh(); void queryClient.invalidateQueries({ queryKey: ['my-access'] }) },
  })

  const devices = useMemo(() => q.data?.devices ?? [], [q.data])
  const counts = useMemo(() => ({
    PENDING: devices.filter((d) => d.status === 'PENDING').length,
    APPROVED: devices.filter((d) => d.status === 'APPROVED').length,
    BLOCKED: devices.filter((d) => d.status === 'REJECTED' || d.status === 'REVOKED').length,
    ALL: devices.length,
  }), [devices])
  const shown = devices.filter((d) => tab === 'ALL' || (tab === 'BLOCKED' ? ['REJECTED', 'REVOKED'].includes(d.status) : d.status === tab))
  const recentPending = devices.filter((d) => d.status === 'PENDING' && Date.now() - new Date(d.last_seen_at).getTime() < 30 * 86_400_000).length
  const cfg = q.data?.settings

  if (!canManage) return <EmptyState icon={<ShieldCheck />} title="Only admins approve devices" description="Ask an owner or admin for access." />

  return (
    <div className="space-y-4">
      <PageHeader title="Device approvals"
        description="Staff who sign in from a new phone or computer wait here until you approve it. Owners are never blocked." />
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <>
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldCheck className="size-4" /> Require approval for new devices
                  <Badge variant={cfg?.enabled ? 'success' : 'neutral'}>{cfg?.enabled ? 'On' : 'Off'}</Badge>
                </CardTitle>
                <CardDescription className="mt-1 max-w-2xl">
                  When on, a staff member on an unapproved device can sign in but sees nothing until it is approved — checked by the server on every request, not just in the browser.
                  Devices are recorded even while it is off, so you can approve them first.
                </CardDescription>
              </div>
              <Switch checked={!!cfg?.enabled} disabled={settings.isPending}
                onCheckedChange={(v) => (v ? setEnableOpen(true) : settings.mutate({ enabled: false }))} aria-label="Require approval for new devices" />
            </CardHeader>
            <CardContent>
              <label className="flex items-start gap-3 text-sm">
                <Switch checked={cfg?.auto_approve_first ?? true} disabled={settings.isPending} onCheckedChange={(v) => settings.mutate({ auto_approve_first: v })} className="mt-0.5" />
                <span>Approve each staff member's first device automatically<span className="block text-xs text-muted-foreground">Turn off to approve every device by hand, including a new staff member's first one.</span></span>
              </label>
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Waiting" value={counts.PENDING} tone={counts.PENDING ? 'warning' : 'default'} />
            <StatCard label="Approved" value={counts.APPROVED} />
            <StatCard label="Blocked" value={counts.BLOCKED} />
            <StatCard label="Staff with devices" value={new Set(devices.map((d) => d.profile_id)).size} />
          </div>

          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList>
              <TabsTrigger value="PENDING">Waiting ({counts.PENDING})</TabsTrigger>
              <TabsTrigger value="APPROVED">Approved ({counts.APPROVED})</TabsTrigger>
              <TabsTrigger value="BLOCKED">Blocked ({counts.BLOCKED})</TabsTrigger>
              <TabsTrigger value="ALL">All ({counts.ALL})</TabsTrigger>
            </TabsList>
          </Tabs>

          {!shown.length ? (
            <EmptyState icon={<MonitorSmartphone />} title={tab === 'PENDING' ? 'No device is waiting' : 'Nothing here'}
              description={tab === 'PENDING' ? 'New sign-ins appear here within a minute.' : undefined} />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {shown.map((d) => (
                <Card key={d.id} className="gap-3 p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">{isPhone(d) ? <Smartphone className="size-5" /> : <Laptop className="size-5" />}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate font-medium">{d.name}</p>
                        <Badge variant={DEVICE_STATUS[d.status as DeviceStatus].variant}>{DEVICE_STATUS[d.status as DeviceStatus].label}</Badge>
                        {d.is_current && <Badge variant="info">This device</Badge>}
                        {!d.is_active && <Badge variant="neutral">Deactivated</Badge>}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{d.role_name} · {d.email}</p>
                    </div>
                  </div>
                  <dl className="grid grid-cols-[90px_1fr] gap-x-2 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">Device</dt><dd className="truncate">{d.label ?? 'Unknown browser'}</dd>
                    <dt className="text-muted-foreground">Last used</dt><dd title={formatDateTime(d.last_seen_at)}>{timeAgo(d.last_seen_at)}{d.ip ? ` · ${d.ip}` : ''}</dd>
                    <dt className="text-muted-foreground">First seen</dt><dd>{formatDateTime(d.first_seen_at)}</dd>
                    {d.decided_at && <><dt className="text-muted-foreground">Decision</dt><dd className="truncate">{d.decided_by ?? 'Automatic'} · {timeAgo(d.decided_at)}{d.note ? ` — ${d.note}` : ''}</dd></>}
                  </dl>
                  <div className="mt-auto flex flex-wrap gap-2">
                    {d.status !== 'APPROVED' && (
                      <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: d.id, action: 'approve' })}><Check /> Approve</Button>
                    )}
                    {d.status === 'PENDING' && (
                      <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => setConfirm({ device: d, action: 'reject' })}><X /> Reject</Button>
                    )}
                    {d.status === 'APPROVED' && !d.is_current && (
                      <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => setConfirm({ device: d, action: 'revoke' })}>Revoke</Button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <ConfirmDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)} destructive reason
        title={confirm?.action === 'reject' ? 'Reject this device?' : 'Revoke this device?'}
        description={confirm && `${confirm.device.name} on ${confirm.device.label ?? 'this browser'} loses access immediately (when approval is on). You can approve it again later.`}
        confirmLabel={confirm?.action === 'reject' ? 'Reject' : 'Revoke'}
        onConfirm={async (reason) => { if (confirm) await decide.mutateAsync({ id: confirm.device.id, action: confirm.action, note: reason }).then(() => setConfirm(null), () => undefined) }} />

      <ConfirmDialog open={enableOpen} onOpenChange={setEnableOpen} title="Turn on device approval?"
        description={
          <span className="grid gap-2">
            <span>Staff on devices that aren't approved will see a "waiting for approval" screen until you approve them here.</span>
            {recentPending > 0 && <span className="font-medium">{recentPending} device(s) used in the last 30 days are still waiting — they will be approved now so nobody is locked out mid-shift.</span>}
          </span>
        }
        confirmLabel="Turn on"
        onConfirm={async () => {
          try {
            if (recentPending > 0) await approveRecentDevices(30)
            await saveDeviceSettings({ enabled: true })
            toast.success('Device approval is on')
            refresh()
          } catch (error) {
            toast.error((error as Error).message) // e.g. "approve the device you are using first"
            refresh()
          }
        }} />
      {settings.isPending && <span className="sr-only"><Spinner /></span>}
    </div>
  )
}
