import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowLeft, Check } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { usePlatform } from '@/features/platform/platform-context'
import { slugify } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { createMerchant, listEmployees } from '@/services/platform'

const STEPS = ['Business', 'Owner', 'Review'] as const

/** Guided onboarding: the business, its owner's login, then one review before anything is created. */
export default function MerchantNewPage() {
  const navigate = useNavigate()
  const { can, me } = usePlatform()
  const [step, setStep] = useState(0)
  const [biz, setBiz] = useState({ name: '', slug: '', phone: '', business_type: '', website: '', address: '', notes: '', is_demo: false, account_manager_id: me?.user_id ?? '' })
  const [owner, setOwner] = useState({ full_name: '', email: '', password: '' })
  const employees = useQuery({ queryKey: ['platform-employees'], queryFn: listEmployees, enabled: can('employees') })
  const create = useMutation({
    mutationFn: () => createMerchant({
      merchant: Object.fromEntries(Object.entries({ ...biz, slug: biz.slug || undefined }).filter(([, v]) => v !== '' && v !== undefined)),
      owner: { full_name: owner.full_name.trim(), email: owner.email.trim(), password: owner.password || undefined },
    }),
    onSuccess: (r) => {
      toast.success('Merchant created', { description: r.owner_invited ? `An invitation went to ${owner.email}.` : 'The owner can sign in with the password you set.' })
      navigate(`/super-admin/merchants/${r.merchant_id}`)
    },
    onError: (e) => toast.error((e as Error).message),
  })

  const bizOk = biz.name.trim().length >= 2 && (!biz.slug || /^[a-z0-9][a-z0-9-]{1,40}$/.test(biz.slug))
  const ownerOk = owner.full_name.trim().length >= 2 && /^\S+@\S+\.\S+$/.test(owner.email.trim()) && (!owner.password || owner.password.length >= 10)
  const setB = (k: keyof typeof biz) => (e: { target: { value: string } }) => setBiz((b) => ({ ...b, [k]: e.target.value }))

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link to="/super-admin/merchants" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Merchants</Link>
      <PageHeader title="New merchant" description="Nothing is created until you confirm on the last step. The account starts in onboarding with the standard roles, statuses and settings." />
      <ol className="flex gap-2">
        {STEPS.map((s, i) => (
          <li key={s} className={cn('flex flex-1 items-center gap-2 rounded-md border px-3 py-2 text-sm', i === step ? 'border-foreground' : 'text-muted-foreground')}>
            <span className={cn('grid size-5 place-items-center rounded-full text-[11px]', i < step ? 'bg-emerald-500 text-white' : 'bg-muted')}>{i < step ? <Check className="size-3" /> : i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">The business</CardTitle><CardDescription>How the platform team will find and contact it.</CardDescription></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <Field label="Business name" required>
              <Input value={biz.name} onChange={(e) => setBiz((b) => ({ ...b, name: e.target.value, slug: b.slug === slugify(b.name) ? slugify(e.target.value) : b.slug }))} />
            </Field>
            <Field label="Short name" hint="Used in links; lowercase letters, numbers and dashes"><Input value={biz.slug} onChange={setB('slug')} /></Field>
            <Field label="Phone"><Input value={biz.phone} onChange={setB('phone')} placeholder="01XXXXXXXXX" /></Field>
            <Field label="Business type"><Input value={biz.business_type} onChange={setB('business_type')} placeholder="Fashion, cosmetics, electronics…" /></Field>
            <Field label="Website"><Input value={biz.website} onChange={setB('website')} /></Field>
            {can('employees') && (
              <Field label="Account manager">
                <Select value={biz.account_manager_id || 'none'} onValueChange={(v) => setBiz((b) => ({ ...b, account_manager_id: v === 'none' ? '' : v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Nobody yet</SelectItem>
                    {(employees.data ?? []).filter((e) => e.is_active).map((e) => <SelectItem key={e.user_id} value={e.user_id}>{e.full_name || e.email}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field label="Address" className="sm:col-span-2"><Input value={biz.address} onChange={setB('address')} /></Field>
            <Field label="Notes for the team" className="sm:col-span-2"><Textarea rows={2} value={biz.notes} onChange={setB('notes')} /></Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Checkbox checked={biz.is_demo} onCheckedChange={(v) => setBiz((b) => ({ ...b, is_demo: v === true }))} />
              Demo / test merchant (kept out of business figures; safe for trying releases)
            </label>
          </CardContent>
        </Card>
      )}

      {step === 1 && (
        <Card>
          <CardHeader><CardTitle className="text-base">The owner</CardTitle>
            <CardDescription>Their login works only for this business. They get an e-mail to set a password, unless you set one here and hand it over.</CardDescription></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" required><Input value={owner.full_name} onChange={(e) => setOwner((o) => ({ ...o, full_name: e.target.value }))} /></Field>
            <Field label="E-mail" required><Input type="email" value={owner.email} onChange={(e) => setOwner((o) => ({ ...o, email: e.target.value }))} /></Field>
            <Field label="Password (optional)" hint="At least 10 characters" className="sm:col-span-2">
              <Input type="password" autoComplete="new-password" value={owner.password} onChange={(e) => setOwner((o) => ({ ...o, password: e.target.value }))} />
            </Field>
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Review</CardTitle><CardDescription>After this the merchant connects its store and couriers from its own admin.</CardDescription></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p><span className="text-muted-foreground">Business:</span> {biz.name}{biz.is_demo && ' (demo)'}</p>
            {biz.phone && <p><span className="text-muted-foreground">Phone:</span> {biz.phone}</p>}
            <p><span className="text-muted-foreground">Owner:</span> {owner.full_name} · {owner.email}</p>
            <p><span className="text-muted-foreground">Login:</span> {owner.password ? 'password set by you' : 'invitation e-mail'}</p>
            <p className="pt-2 text-xs text-muted-foreground">Created with: 8 staff roles, order statuses and sources, finance categories, fraud rules, delivery zones, message templates and default settings — none of another merchant's data.</p>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-between">
        <Button variant="outline" disabled={step === 0 || create.isPending} onClick={() => setStep((s) => s - 1)}>Back</Button>
        {step < STEPS.length - 1
          ? <Button disabled={(step === 0 && !bizOk) || (step === 1 && !ownerOk)} onClick={() => setStep((s) => s + 1)}>Continue</Button>
          : <Button disabled={create.isPending || !bizOk || !ownerOk} onClick={() => create.mutate()}>{create.isPending && <Spinner />} Create merchant</Button>}
      </div>
    </div>
  )
}
