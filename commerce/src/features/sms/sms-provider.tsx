import { useMutation } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { connectSms, sendTestSms, type SmsProviderCode, type SmsSettings } from '@/services/sms'
import { smsParts } from './sms-text'

interface CredentialField { key: string; label: string; secret?: boolean; placeholder?: string; hint?: string }

export const SMS_PROVIDERS: Array<{
  code: SmsProviderCode
  name: string
  blurb: string
  where: string
  sender: 'required' | 'optional' | 'none'
  reports: boolean
  required: string[]
  fields: CredentialField[]
}> = [
  {
    code: 'smsnetbd', name: 'Alpha SMS (sms.net.bd)', blurb: 'Delivery reports and the exact charge for each message.',
    where: 'portal.sms.net.bd → API', sender: 'optional', reports: true, required: ['api_key'],
    fields: [{ key: 'api_key', label: 'API key', secret: true }],
  },
  {
    code: 'bulksmsbd', name: 'BulkSMSBD', blurb: 'Balance check; delivery is not reported back.',
    where: 'bulksmsbd.net → API settings', sender: 'required', reports: false, required: ['api_key'],
    fields: [{ key: 'api_key', label: 'API key', secret: true }],
  },
  {
    code: 'sslwireless', name: 'SSL Wireless (ISMS Plus)', blurb: 'Each message carries a unique id, so a retry can never send it twice.',
    where: 'ISMS Plus portal → API (also whitelist the server IP there)', sender: 'none', reports: false, required: ['api_token', 'sid'],
    fields: [{ key: 'api_token', label: 'API token', secret: true }, { key: 'sid', label: 'SID', hint: 'Your sender (masking or non-masking) is tied to the SID.' }],
  },
  {
    code: 'http', name: 'Other provider (HTTP API)', blurb: 'Any gateway that sends with one web address, e.g. MiM SMS, GreenWeb, Elitbuzz.',
    where: 'Your provider’s API documentation', sender: 'optional', reports: false, required: ['url_template'],
    fields: [
      { key: 'url_template', label: 'Send URL', placeholder: 'https://api.example.com/send?key={key}&to={to}&from={sender}&text={message}',
        hint: 'Use {to}, {message}, {sender} and {key}; they are filled in and encoded for each message.' },
      { key: 'api_key', label: 'API key (fills {key})', secret: true },
      { key: 'success_pattern', label: 'Reply must contain (optional)', placeholder: 'e.g. "status":"success"', hint: 'A regular expression the reply must match to count as sent.' },
    ],
  },
]

export const providerName = (code: string | null | undefined) => SMS_PROVIDERS.find((p) => p.code === code)?.name ?? code ?? '—'

export function ConnectSmsDialog({ current, onClose, onDone }: { current: SmsSettings; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState<SmsProviderCode>(current.provider ?? 'smsnetbd')
  const [values, setValues] = useState<Record<string, string>>({})
  const [senderId, setSenderId] = useState(current.sender_id ?? '')
  const [method, setMethod] = useState('GET')
  const [advanced, setAdvanced] = useState(false)
  const provider = SMS_PROVIDERS.find((p) => p.code === code)!
  const connect = useMutation({
    mutationFn: () => connectSms(code, { ...values, ...(code === 'http' ? { method } : {}) }, provider.sender === 'none' ? '' : senderId.trim()),
    onSuccess: (r) => { toast.success(r.message); onDone(); onClose() },
  })
  const missing = provider.required.some((k) => !values[k]?.trim()) || (provider.sender === 'required' && !senderId.trim())

  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={current.connected ? 'Change SMS provider' : 'Connect SMS provider'}
      submitLabel="Test and connect" busy={connect.isPending} disabled={missing} onSubmit={() => connect.mutate()}
      description="The keys are checked with the provider, then stored encrypted on the server. Nobody can read them back — not even here.">
      <Field label="Provider">
        <Select value={code} onValueChange={(v) => { setCode(v as SmsProviderCode); setValues({}) }}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{SMS_PROVIDERS.map((p) => <SelectItem key={p.code} value={p.code}>{p.name}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <p className="-mt-2 text-xs text-muted-foreground">{provider.blurb} Find the keys in: {provider.where}.</p>
      {provider.fields.map((f) => (
        <Field key={f.key} label={f.label} htmlFor={`sms-${f.key}`} hint={f.hint}>
          <Input id={`sms-${f.key}`} type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} placeholder={f.placeholder}
            className={f.key === 'url_template' ? 'font-mono text-xs' : undefined}
            value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
        </Field>
      ))}
      {code === 'http' && (
        <Field label="Send with">
          <Select value={method} onValueChange={setMethod}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="GET">GET (parameters in the URL)</SelectItem><SelectItem value="POST">POST (parameters as a form)</SelectItem></SelectContent>
          </Select>
        </Field>
      )}
      {provider.sender !== 'none' && (
        <Field label={provider.sender === 'required' ? 'Sender ID' : 'Sender ID (optional)'} htmlFor="sms-sender"
          hint="The name or number customers see. A masking name (e.g. your brand) must be approved by the provider first.">
          <Input id="sms-sender" value={senderId} maxLength={20} onChange={(e) => setSenderId(e.target.value)} placeholder="e.g. MyShop or 8809601234567" />
        </Field>
      )}
      {code !== 'http' && (
        <div>
          <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setAdvanced((a) => !a)}>
            <ChevronDown className={`size-3 transition-transform ${advanced ? 'rotate-180' : ''}`} /> Advanced
          </button>
          {advanced && (
            <Field label="API address" htmlFor="sms-base" hint="Leave empty to use the provider’s normal address." className="mt-2">
              <Input id="sms-base" value={values.base_url ?? ''} onChange={(e) => setValues((v) => ({ ...v, base_url: e.target.value }))} placeholder="https://…" />
            </Field>
          )}
        </div>
      )}
    </FormDialog>
  )
}

export function TestSmsDialog({ storeName, onClose, onSent }: { storeName: string; onClose: () => void; onSent: () => void }) {
  const [to, setTo] = useState('')
  const [message, setMessage] = useState(`Test message from ${storeName || 'our store'}. SMS is working.`)
  const parts = smsParts(message)
  const send = useMutation({
    mutationFn: () => sendTestSms(to.trim(), message),
    onSuccess: () => { toast.success('Test SMS sent'); onSent(); onClose() },
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="Send a test SMS" submitLabel="Send" busy={send.isPending}
      disabled={!/^(\+?88)?01[3-9]\d{8}$/.test(to.replace(/[\s-]/g, '')) || !message.trim()} onSubmit={() => send.mutate()}
      description="Sent through the connected provider. It is logged and its cost is recorded like any other message.">
      <Field label="Mobile number" htmlFor="test-to">
        <Input id="test-to" inputMode="tel" value={to} onChange={(e) => setTo(e.target.value)} placeholder="01XXXXXXXXX" />
      </Field>
      <Field label="Message" htmlFor="test-msg" hint={`${message.length} characters · ${parts.segments} SMS${parts.encoding === 'UNICODE' ? ' · Unicode' : ''}`}>
        <Textarea id="test-msg" rows={3} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />
      </Field>
    </FormDialog>
  )
}
