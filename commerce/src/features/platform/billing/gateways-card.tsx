import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { formatDateTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { billingGateways, connectGateway, disconnectGateway, toggleBillingGateway } from '@/services/credits'

type Code = 'bkash' | 'paystation'
const GATEWAYS: Record<Code, { name: string; fields: Array<{ key: string; label: string; secret?: boolean }> }> = {
  bkash: { name: 'bKash (tokenized checkout)', fields: [{ key: 'app_key', label: 'App key' }, { key: 'app_secret', label: 'App secret', secret: true }, { key: 'username', label: 'Username' }, { key: 'password', label: 'Password', secret: true }] },
  paystation: { name: 'PayStation', fields: [{ key: 'merchant_id', label: 'Merchant ID' }, { key: 'password', label: 'Password', secret: true }] },
}

function ConnectDialog({ code, onClose }: { code: Code; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [values, setValues] = useState<Record<string, string>>({})
  const [sandbox, setSandbox] = useState(true)
  const connect = useMutation({
    mutationFn: () => connectGateway(code, sandbox, Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()))),
    onSuccess: (r) => { toast.success(r.message || 'Connected'); void queryClient.invalidateQueries({ queryKey: ['platform-gateways'] }); onClose() },
    onError: (e) => toast.error((e as Error).message),
  })
  const g = GATEWAYS[code]
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={`Connect the company's ${g.name} account`} busy={connect.isPending}
      description="For payments merchants make to the platform (invoices and credit packages). The credentials are tested, then stored encrypted; they are never shown again. Merchants' own gateways for their customers are separate and unchanged."
      disabled={g.fields.some((f) => !values[f.key]?.trim())} onSubmit={() => connect.mutate()} submitLabel="Test and connect">
      {g.fields.map((f) => (
        <Field key={f.key} label={f.label} required>
          <Input type={f.secret ? 'password' : 'text'} autoComplete="off" value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
        </Field>
      ))}
      <label className="flex items-center gap-2 text-sm"><Switch checked={sandbox} onCheckedChange={setSandbox} /> Sandbox (test money)</label>
    </FormDialog>
  )
}

/** The company's gateway accounts that merchants pay the platform with. */
export function GatewaysCard() {
  const queryClient = useQueryClient()
  const data = useQuery({ queryKey: ['platform-gateways'], queryFn: billingGateways })
  const [connecting, setConnecting] = useState<Code | null>(null)
  const [disconnecting, setDisconnecting] = useState<Code | null>(null)
  if (data.error) return <ErrorState error={data.error} />
  if (!data.data) return <LoadingState />
  const manage = data.data.can_manage
  return (
    <Card className="lg:col-span-2">
      <CardHeader><CardTitle className="text-sm">Online payment to the platform</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">Merchants pay invoices and buy credits through these accounts. A payment counts only when the gateway confirms it server to server and the amount matches; otherwise it is never marked paid.</p>
        {(Object.keys(GATEWAYS) as Code[]).map((code) => {
          const g = data.data.gateways[code] ?? {}
          return (
            <div key={code} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="font-medium">{GATEWAYS[code].name}</span>{' '}
                {g.connected ? <Badge variant={g.enabled ? 'success' : 'neutral'}>{g.enabled ? 'taking payments' : 'connected, off'}</Badge> : <Badge variant="neutral">not connected</Badge>}
                {g.sandbox && g.connected && <Badge variant="warning" className="ml-1">sandbox</Badge>}
                {g.connected && <span className="block text-xs text-muted-foreground">{g.hint} · since {formatDateTime(g.connected_at ?? null)}</span>}
              </span>
              {manage && (
                <span className="flex items-center gap-2">
                  {g.connected && (
                    <Switch aria-label={`${GATEWAYS[code].name} on`} checked={g.enabled === true} onCheckedChange={async (v) => {
                      try { await toggleBillingGateway(code, v); void queryClient.invalidateQueries({ queryKey: ['platform-gateways'] }) } catch (e) { toast.error((e as Error).message) }
                    }} />
                  )}
                  <Button size="sm" variant="outline" onClick={() => setConnecting(code)}>{g.connected ? 'Change' : 'Connect'}</Button>
                  {g.connected && <Button size="sm" variant="ghost" onClick={() => setDisconnecting(code)}>Disconnect</Button>}
                </span>
              )}
            </div>
          )
        })}
      </CardContent>
      {connecting && <ConnectDialog code={connecting} onClose={() => setConnecting(null)} />}
      {disconnecting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDisconnecting(null)} destructive reason reasonRequired confirmLabel="Disconnect"
          title={`Disconnect ${GATEWAYS[disconnecting].name}?`} description="Merchants can no longer pay with it. Payments already confirmed are kept; attempts still open are checked by the reconcile job only while connected."
          onConfirm={async () => {
            try { await disconnectGateway(disconnecting); void queryClient.invalidateQueries({ queryKey: ['platform-gateways'] }) } catch (e) { toast.error((e as Error).message); throw e }
          }} />
      )}
    </Card>
  )
}
