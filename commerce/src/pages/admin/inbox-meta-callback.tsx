import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Field } from '@/components/common/field'
import { LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { handBack, startedInPopup } from '@/features/inbox/meta-popup'
import { PlatformIcon } from '@/features/inbox/ui'
import { toUserMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { type MetaFinish, metaConnect, metaConnectFinish } from '@/services/inbox'

const CHANNELS = '/admin/inbox/channels'

/**
 * Where Meta sends the store owner back after "Continue with Facebook": the code
 * is swapped for access (once), then they tick the Pages, Instagram accounts or
 * WhatsApp numbers to connect.
 */
export default function InboxMetaCallbackPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const code = params.get('code') ?? ''
  const state = params.get('state') ?? ''
  const denied = params.get('error') || params.get('error_reason')
  const started = useRef(false)
  // Opened as Meta's popup: hand the answer to the Channels page behind it, then close.
  const [handing, setHanding] = useState(() => !!state && startedInPopup(state))

  // The code works only once: never send it twice (React runs effects twice in development).
  const finish = useMutation({ mutationFn: () => metaConnectFinish(code, state) })
  useEffect(() => {
    if (started.current) return
    if (handing) {
      started.current = true
      void handBack(window.location.search).then((taken) => {
        if (taken) { window.close(); return }
        started.current = false
        setHanding(false)
      })
      return
    }
    if (denied || !code || !state) return
    started.current = true
    finish.mutate()
  }, [code, state, denied, finish, handing])

  if (handing) return <LoadingState label="Finishing in Fullfilio…" />

  if (denied || (!code && !finish.isPending)) {
    return (
      <Shell>
        <CardHeader>
          <CardTitle>Facebook sign-in was not finished</CardTitle>
          <CardDescription>{params.get('error_description') ?? 'Nothing was connected. You can try again whenever you are ready.'}</CardDescription>
        </CardHeader>
        <CardFooter><Button asChild variant="outline"><Link to={CHANNELS}><ArrowLeft /> Back to Channels</Link></Button></CardFooter>
      </Shell>
    )
  }
  if (finish.error) {
    return (
      <Shell>
        <CardHeader>
          <CardTitle>Could not finish connecting</CardTitle>
          <CardDescription>{toUserMessage(finish.error)}</CardDescription>
        </CardHeader>
        <CardFooter><Button asChild variant="outline"><Link to={CHANNELS}><ArrowLeft /> Back to Channels and try again</Link></Button></CardFooter>
      </Shell>
    )
  }
  if (!finish.data) return <LoadingState label="Getting your Pages from Facebook…" />

  const done = () => {
    void qc.invalidateQueries({ queryKey: ['inbox-overview'] })
    navigate(CHANNELS, { replace: true })
  }
  return finish.data.kind === 'WHATSAPP'
    ? <NumberPicker data={finish.data} onDone={done} />
    : <PagePicker data={finish.data} onDone={done} />
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-2xl py-6"><Card>{children}</Card></div>
}

function report(r: { channels: Array<{ name: string }>; warnings: string[] }) {
  if (r.channels.length) toast.success(`Connected ${r.channels.map((c) => c.name).join(', ')}`)
  r.warnings.forEach((w) => toast.warning(w))
}

function PagePicker({ data, onDone }: { data: Exclude<MetaFinish, { kind: 'WHATSAPP' }>; onDone: () => void }) {
  // Everything not connected yet starts ticked.
  const [picked, setPicked] = useState(() => new Set(data.pages.flatMap((p) => [
    ...(p.connected ? [] : [`fb:${p.id}`]), ...(p.instagram && !p.instagram.connected ? [`ig:${p.id}`] : []),
  ])))
  const [comments, setComments] = useState(true)
  const toggle = (k: string, on: boolean) => setPicked((s) => { const n = new Set(s); if (on) n.add(k); else n.delete(k); return n })
  const pages = data.pages
    .map((p) => ({ id: p.id, facebook: picked.has(`fb:${p.id}`), instagram: picked.has(`ig:${p.id}`) }))
    .filter((p) => p.facebook || p.instagram)
  const connect = useMutation({
    mutationFn: () => metaConnect({ pages, comments }),
    onSuccess: (r) => { report(r); onDone() },
    onError: (e) => toast.error(toUserMessage(e)),
  })

  return (
    <Shell>
      <CardHeader>
        <CardTitle>Choose what to connect</CardTitle>
        <CardDescription>The Pages you allowed on Facebook, with their Instagram accounts.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.pages.length === 0 ? (
          <p className="rounded-[10px] bg-amber-500/10 px-3 py-2.5 text-sm">
            Facebook did not share any Page. Go back, choose “Continue with Facebook” again and, when Facebook asks, tick the Pages you want and allow every permission.
          </p>
        ) : (
          <ul className="divide-y rounded-[10px] border">
            {data.pages.map((p) => (
              <li key={p.id} className="space-y-2 px-3 py-3">
                <Row id={`fb:${p.id}`} checked={picked.has(`fb:${p.id}`)} onChange={toggle} icon={<PlatformIcon platform="FACEBOOK" className="size-5" />}
                  picture={p.picture} name={p.name} hint="Facebook Page · Messenger and comments" connected={p.connected} />
                {p.instagram ? (
                  <Row id={`ig:${p.id}`} checked={picked.has(`ig:${p.id}`)} onChange={toggle} icon={<PlatformIcon platform="INSTAGRAM" className="size-5" />}
                    picture={p.instagram.picture} name={p.instagram.username ? `@${p.instagram.username}` : 'Instagram account'} hint="Instagram · DMs and comments" connected={p.instagram.connected} indent />
                ) : (
                  <p className="pl-9 text-xs text-muted-foreground">No Instagram professional account is linked to this Page.</p>
                )}
              </li>
            ))}
          </ul>
        )}
        <label className="flex items-center justify-between gap-3 text-sm">
          Bring post, Reel and ad comments into the inbox <Switch checked={comments} onCheckedChange={setComments} />
        </label>
      </CardContent>
      <CardFooter className="justify-between gap-2">
        <Button asChild variant="ghost"><Link to={CHANNELS}>Cancel</Link></Button>
        <Button onClick={() => connect.mutate()} disabled={connect.isPending || pages.length === 0}>
          {connect.isPending ? <Spinner /> : <CheckCircle2 />} Connect {pages.length ? `(${pages.reduce((n, p) => n + Number(p.facebook) + Number(p.instagram), 0)})` : ''}
        </Button>
      </CardFooter>
    </Shell>
  )
}

function NumberPicker({ data, onDone }: { data: Extract<MetaFinish, { kind: 'WHATSAPP' }>; onDone: () => void }) {
  const [picked, setPicked] = useState(() => new Set(data.numbers.filter((n) => !n.connected).map((n) => n.id)))
  const [pin, setPin] = useState('')
  const numbers = data.numbers.filter((n) => picked.has(n.id)).map((n) => ({ id: n.id, waba_id: n.waba_id }))
  const connect = useMutation({
    mutationFn: () => metaConnect({ numbers, pin: data.coexist ? undefined : pin }),
    onSuccess: (r) => { report(r); onDone() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const toggle = (k: string, on: boolean) => setPicked((s) => { const n = new Set(s); if (on) n.add(k); else n.delete(k); return n })

  return (
    <Shell>
      <CardHeader>
        <CardTitle>Choose your WhatsApp number</CardTitle>
        <CardDescription>The numbers you shared during WhatsApp sign-up.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.numbers.length === 0 ? (
          <p className="rounded-[10px] bg-amber-500/10 px-3 py-2.5 text-sm">No WhatsApp number was shared. Go back and choose “Connect WhatsApp” again, then pick or add your number when Facebook asks.</p>
        ) : (
          <ul className="divide-y rounded-[10px] border">
            {data.numbers.map((n) => (
              <li key={n.id} className="px-3 py-3">
                <Row id={n.id} checked={picked.has(n.id)} onChange={toggle} icon={<PlatformIcon platform="WHATSAPP" className="size-5" />}
                  picture={null} name={n.name ?? n.display_phone ?? n.id} hint={n.display_phone ?? 'WhatsApp Business'} connected={n.connected} />
              </li>
            ))}
          </ul>
        )}
        {data.coexist ? (
          <p className="rounded-[10px] bg-muted px-3 py-2.5 text-xs text-muted-foreground">This number stays on the WhatsApp Business app. Keep the app open on the phone while your chats sync.</p>
        ) : (
          <Field label="Two-step verification PIN (6 digits)" hint="If the number already has a WhatsApp two-step PIN, enter it. Otherwise choose one and keep it safe.">
            <Input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="off" className="w-40 tracking-[0.3em]" placeholder="••••••" />
          </Field>
        )}
      </CardContent>
      <CardFooter className="justify-between gap-2">
        <Button asChild variant="ghost"><Link to={CHANNELS}>Cancel</Link></Button>
        <Button onClick={() => connect.mutate()} disabled={connect.isPending || numbers.length === 0 || (!data.coexist && pin.length !== 6)}>
          {connect.isPending ? <Spinner /> : <CheckCircle2 />} Connect
        </Button>
      </CardFooter>
    </Shell>
  )
}

function Row({ id, checked, onChange, icon, picture, name, hint, connected, indent }: {
  id: string; checked: boolean; onChange: (id: string, on: boolean) => void; icon: React.ReactNode
  picture: string | null; name: string; hint: string; connected: boolean; indent?: boolean
}) {
  return (
    <label className={`flex cursor-pointer items-center gap-3 ${indent ? 'pl-9' : ''}`}>
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(id, v === true)} aria-label={name} />
      {picture ? <img src={picture} alt="" className="size-8 rounded-full object-cover" /> : <span className="grid size-8 place-items-center rounded-full bg-muted">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium">{name}{connected && <Badge variant="success">Connected</Badge>}</span>
        <span className="block text-xs text-muted-foreground">{connected ? 'Tick to refresh its access' : hint}</span>
      </span>
    </label>
  )
}
