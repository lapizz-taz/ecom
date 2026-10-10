import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, PlugZap, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/features/auth/auth-context'
import { formatDateTime } from '@/lib/format'
import {
  connectGateway, disconnectGateway, type Gateway, type GatewayCredentials, getSettings, integrationStatus, testGateway,
} from '@/services/settings'

const GATEWAYS: Array<{
  code: Gateway
  name: string
  description: string
  fields: Array<{ key: keyof GatewayCredentials; label: string; secret?: boolean; optional?: boolean; hint?: string }>
}> = [
  {
    code: 'bkash',
    name: 'bKash',
    description: 'bKash Tokenized Checkout (Merchant API). Customers approve the payment in the bKash page; the order is approved only after bKash confirms it to the server.',
    fields: [
      { key: 'app_key', label: 'App key' },
      { key: 'app_secret', label: 'App secret', secret: true },
      { key: 'username', label: 'Username' },
      { key: 'password', label: 'Password', secret: true },
    ],
  },
  {
    code: 'paystation',
    name: 'PayStation',
    description: 'One payment page for Nagad, Rocket, Upay, bKash and cards. Every payment is checked with PayStation\'s transaction-status API before it counts.',
    fields: [
      { key: 'merchant_id', label: 'Merchant ID' },
      { key: 'password', label: 'Password', secret: true },
      { key: 'token', label: 'Status API token', secret: true, optional: true, hint: 'Only if PayStation gave you a separate token; otherwise the password is used.' },
    ],
  },
]

/** Settings → Payments: connect, test and disconnect the online gateways. */
export function PaymentGateways() {
  const { can } = useAuth()
  const status = useQuery({ queryKey: ['integration-status'], queryFn: integrationStatus })
  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const providers = (settings.data?.payments as { providers?: Record<string, { enabled?: boolean; sandbox?: boolean }> } | undefined)?.providers
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Online payment gateways</CardTitle>
        <CardDescription>
          Used for the advance (for example the ৳55 delivery charge) and full online payments. Credentials are tested with the gateway,
          then stored encrypted on the server — they never reach a browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {status.isLoading ? <LoadingState /> : GATEWAYS.map((g) => (
          <GatewayRow key={g.code} gateway={g} canManage={can('settings.manage')} info={status.data?.[`payments.${g.code}`]}
            config={providers?.[g.code]} />
        ))}
      </CardContent>
    </Card>
  )
}

function GatewayRow({ gateway, canManage, info, config }: {
  gateway: (typeof GATEWAYS)[number]
  canManage: boolean
  info: { connected: boolean; hint: string | null; connected_at: string; connected_by_name: string | null } | undefined
  config: { enabled?: boolean; sandbox?: boolean } | undefined
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)
  const connected = !!info?.connected
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['integration-status'] })
    void queryClient.invalidateQueries({ queryKey: ['settings'] })
    void queryClient.invalidateQueries({ queryKey: ['store-config'] })
  }
  const test = useMutation({
    meta: { silent: true },
    mutationFn: () => testGateway(gateway.code),
    onSuccess: (r) => toast.success(r.message),
    onError: (e) => toast.error(e.message),
  })
  const disconnect = useMutation({
    mutationFn: () => disconnectGateway(gateway.code),
    onSuccess: () => { toast.success(`${gateway.name} disconnected`); refresh() },
  })
  return (
    <div className="rounded-xl border p-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${connected && config?.enabled ? 'bg-emerald-500' : 'bg-zinc-300'}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{gateway.name}</p>
            {connected && gateway.code === 'bkash' && <Badge variant={config?.sandbox === false ? 'success' : 'warning'}>{config?.sandbox === false ? 'Live' : 'Sandbox'}</Badge>}
            {connected && !config?.enabled && <Badge variant="neutral">Off</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {connected
              ? <>{info?.hint} · {info?.connected_by_name ? `${info.connected_by_name}, ` : ''}{formatDateTime(info!.connected_at)}</>
              : gateway.description}
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            {connected && <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? <Spinner /> : <CircleCheck />} Test</Button>}
            <Button size="sm" variant={connected ? 'outline' : 'default'} onClick={() => setOpen(true)}><PlugZap /> {connected ? 'Change' : 'Connect'}</Button>
            {connected && <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setConfirmOff(true)}><Unplug /> Disconnect</Button>}
          </div>
        )}
      </div>
      {open && <ConnectGatewayDialog gateway={gateway} sandbox={config?.sandbox !== false} onClose={() => setOpen(false)} onConnected={refresh} />}
      <ConfirmDialog open={confirmOff} onOpenChange={setConfirmOff} title={`Disconnect ${gateway.name}?`} destructive
        description="Its credentials are deleted from the server and customers no longer see it at checkout. Payments already made are kept."
        confirmLabel="Disconnect" onConfirm={() => disconnect.mutateAsync()} />
    </div>
  )
}

function ConnectGatewayDialog({ gateway, sandbox: initialSandbox, onClose, onConnected }: {
  gateway: (typeof GATEWAYS)[number]
  sandbox: boolean
  onClose: () => void
  onConnected: () => void
}) {
  const [values, setValues] = useState<GatewayCredentials>({})
  const [sandbox, setSandbox] = useState(initialSandbox)
  const [advanced, setAdvanced] = useState(false)
  useEffect(() => setSandbox(initialSandbox), [initialSandbox])
  const connect = useMutation({
    meta: { silent: true },
    mutationFn: () => connectGateway(gateway.code, values, gateway.code === 'bkash' ? sandbox : undefined),
    onSuccess: (r) => { toast.success(r.message); onConnected(); onClose() },
  })
  const missing = gateway.fields.some((f) => !f.optional && !values[f.key]?.trim())
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={`Connect ${gateway.name}`} submitLabel="Test and connect"
      busy={connect.isPending} disabled={missing} onSubmit={() => connect.mutate()}
      description={`From your ${gateway.name} merchant account. We test them with ${gateway.name} before saving.`}>
      {gateway.fields.map((f) => (
        <Field key={f.key} label={f.label + (f.optional ? ' (optional)' : '')} htmlFor={`gw-${f.key}`} hint={f.hint}>
          <Input id={`gw-${f.key}`} type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} className="font-mono"
            value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
        </Field>
      ))}
      {gateway.code === 'bkash' && (
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={sandbox} onCheckedChange={setSandbox} /> Sandbox (test credentials from bKash)
        </label>
      )}
      {advanced ? (
        <Field label="API address (optional)" htmlFor="gw-base" hint="Leave empty unless the gateway gave you a different address.">
          <Input id="gw-base" placeholder="https://" value={values.base_url ?? ''} onChange={(e) => setValues((v) => ({ ...v, base_url: e.target.value }))} />
        </Field>
      ) : (
        <button type="button" className="w-fit text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => setAdvanced(true)}>Advanced</button>
      )}
      {connect.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{connect.error.message}</p>}
    </FormDialog>
  )
}
