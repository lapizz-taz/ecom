import { Bell, BellOff, BellRing, Check, Download, EllipsisVertical, Share, Smartphone, SquarePlus, Volume2 } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { canPromptInstall, isStandalone, onInstallPromptChange, phonePlatform, promptInstall } from '@/lib/app-install'
import { ORDER_SOUND_URL, orderSoundOn, playOrderSound, setOrderSoundOn, unlockOrderSound } from '@/lib/order-sound'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { disablePush, enablePush, type PushState, pushDevices, pushState, pushSupported, sendTestPush } from '@/services/push'

// Fullfilio on the phone: how to add it to the home screen (iPhone and Android), and new-order
// notifications on this device. Each popup shows once per device (AppOnboarding); both can be
// opened again from the account menu and My account.

const GUIDE_SEEN = 'fullfilio-install-guide-seen'
const PUSH_ASKED = 'fullfilio-push-asked'

function flag(key: string): boolean {
  try { return localStorage.getItem(key) === '1' } catch { return true }
}
function setFlag(key: string) {
  try { localStorage.setItem(key, '1') } catch { /* private mode: it may show again */ }
}

function useInstallPrompt(): boolean {
  const [can, setCan] = useState(canPromptInstall)
  useEffect(() => onInstallPromptChange(() => setCan(canPromptInstall())), [])
  return can
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/12 text-xs font-semibold text-brand tabular-nums">{n}</span>
      <span className="pt-0.5 text-sm leading-relaxed">{children}</span>
    </li>
  )
}

const Key = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex items-center gap-1 rounded-md border bg-muted/50 px-1.5 py-px align-middle text-[13px] font-medium whitespace-nowrap">{children}</span>
)

/** Turning new-order notifications on and off for this device, with a test. */
export function NotificationsPanel({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<PushState | null>(null)
  const [devices, setDevices] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const s = await pushState()
      setState(s)
      if (s !== 'unsupported' && s !== 'install-first') setDevices((await pushDevices()).devices)
    } catch {
      setState(pushSupported() ? 'off' : 'unsupported')
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try { await work() } catch (e) { toast.error((e as Error).message || 'Something went wrong — please try again') } finally {
      setBusy(false)
      void refresh()
    }
  }
  const turnOn = () => run(async () => {
    const s = await enablePush()
    if (s === 'on') toast.success('Notifications are on', { description: 'You will hear about every new order on this device.' })
    else if (s === 'blocked') toast.error('Notifications are blocked', { description: 'Allow them for fullfilio.com in the browser\'s settings, then try again.' })
  })
  const turnOff = () => run(async () => { await disablePush(); toast.success('Notifications are off on this device') })
  const test = () => run(async () => {
    const r = await sendTestPush()
    if (r.sent > 0) toast.success('Test sent', { description: 'It should show up in a few seconds.' })
    else toast.error('The test did not go through', { description: 'Turn notifications off and on again on this device.' })
  })

  const message: Record<Exclude<PushState, 'off' | 'on'>, ReactNode> = {
    'unsupported': 'This browser cannot show notifications. Use Chrome, Edge, Samsung Internet, Firefox or Safari.',
    'install-first': <>On iPhone and iPad, notifications work in the app: add Fullfilio to the Home Screen, open it from there and turn them on here (iOS 16.4 or later).</>,
    'blocked': <>Notifications are blocked for fullfilio.com in this browser. Allow them in the browser&apos;s site settings, then come back here.</>,
  }

  return (
    <div className={cn('space-y-3', !compact && 'rounded-xl border p-4')}>
      <div className="flex items-start gap-3">
        <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-full',
          state === 'on' ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' : 'bg-brand/12 text-brand')}>
          {state === 'on' ? <BellRing className="size-4.5" /> : state === 'blocked' ? <BellOff className="size-4.5" /> : <Bell className="size-4.5" />}
        </span>
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">New-order notifications</p>
          <p className="text-sm text-muted-foreground">
            {state === null ? 'Checking this device…'
              : state === 'on' ? 'On for this device. Every new order shows up here, even when Fullfilio is closed.'
              : state === 'off' ? 'Get a notification on this device for every new order, even when Fullfilio is closed.'
              : message[state]}
          </p>
          {devices !== null && devices > 0 && <p className="text-xs text-muted-foreground">{devices} of your devices get{devices === 1 ? 's' : ''} them.</p>}
        </div>
      </div>
      {(state === 'off' || state === 'on') && (
        <div className="flex flex-wrap gap-2 pl-12">
          {state === 'off' && <Button size="sm" onClick={() => void turnOn()} disabled={busy}><Bell /> Turn on notifications</Button>}
          {state === 'on' && (
            <>
              <Button size="sm" variant="outline" onClick={() => void test()} disabled={busy}><BellRing /> Send a test</Button>
              <Button size="sm" variant="ghost" onClick={() => void turnOff()} disabled={busy}><BellOff /> Turn off</Button>
            </>
          )}
        </div>
      )}
      <OrderSound />
    </div>
  )
}

/** The "ka-ching" for new orders on this device (src/lib/order-sound.ts). */
function OrderSound() {
  const [on, setOn] = useState(orderSoundOn)
  const platform = phonePlatform()
  const toggle = (next: boolean) => {
    setOrderSoundOn(next)
    setOn(next)
    if (next) unlockOrderSound()
  }
  const play = async () => {
    unlockOrderSound()
    if (!(await playOrderSound())) {
      toast.error('The sound did not play', { description: 'Check the volume and that the phone is not on silent, then tap Play again.' })
    }
  }
  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand/12 text-brand"><Volume2 className="size-4.5" /></span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="order-sound" className="text-sm font-medium">Ka-ching for new orders</Label>
            <Switch id="order-sound" checked={on} onCheckedChange={toggle} />
          </div>
          <p className="text-sm text-muted-foreground">
            Plays on this device while Fullfilio is open: once for each new order, once for a burst. With Fullfilio closed or
            the phone locked, the notification makes the phone&apos;s own sound.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-12">
        <Button size="sm" variant="outline" onClick={() => void play()}><Volume2 /> Play</Button>
        {platform === 'android' && (
          <Button size="sm" variant="ghost" asChild>
            <a href={ORDER_SOUND_URL} download="fullfilio-ka-ching.mp3"><Download /> Download the sound</a>
          </Button>
        )}
      </div>
      {platform === 'android' && (
        <p className="pl-12 text-xs text-muted-foreground">
          To hear it with the phone locked too: download it, then open Settings → Apps → Fullfilio (or Chrome, if you use
          Fullfilio in the browser) → Notifications, and choose the downloaded file as the sound.
        </p>
      )}
      {platform === 'ios' && (
        <p className="pl-12 text-xs text-muted-foreground">With Fullfilio closed, iPhone uses its own sound for notifications; a website&apos;s app cannot change it.</p>
      )}
    </div>
  )
}

/** How to put Fullfilio on the home screen, on iPhone and on Android. */
export function InstallAppDialog({ open, onOpenChange, showNotifications = true }: { open: boolean; onOpenChange: (open: boolean) => void; showNotifications?: boolean }) {
  const platform = phonePlatform()
  const [tab, setTab] = useState<'ios' | 'android'>(platform === 'ios' ? 'ios' : 'android')
  const canPrompt = useInstallPrompt()
  const installed = isStandalone()
  const install = async () => {
    if (await promptInstall()) {
      toast.success('Fullfilio is on your home screen', { description: 'Open it from there: it starts on your dashboard.' })
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <span className="mb-1 inline-flex size-10 items-center justify-center rounded-full bg-brand/12 text-brand"><Smartphone className="size-5" /></span>
          <DialogTitle>{installed ? 'Fullfilio is on this device' : 'Get the Fullfilio app'}</DialogTitle>
          <DialogDescription>
            {installed ? 'You are using the app. It opens straight on your dashboard.'
              : 'Add Fullfilio to your home screen. It opens straight on your dashboard, full screen, like any app.'}
          </DialogDescription>
        </DialogHeader>

        {!installed && (
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'ios' | 'android')}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="ios">iPhone / iPad</TabsTrigger>
              <TabsTrigger value="android">Android</TabsTrigger>
            </TabsList>
            <TabsContent value="ios" className="pt-3">
              <ol className="space-y-3">
                <Step n={1}>Open <span className="font-medium">fullfilio.com/admin</span> in <span className="font-medium">Safari</span>.</Step>
                <Step n={2}>Tap the Share button <Key><Share className="size-3.5" /> Share</Key> at the bottom of the screen (at the top on iPad).</Step>
                <Step n={3}>Scroll down and tap <Key><SquarePlus className="size-3.5" /> Add to Home Screen</Key>.</Step>
                <Step n={4}>Tap <Key>Add</Key>. Fullfilio is now on your Home Screen.</Step>
              </ol>
            </TabsContent>
            <TabsContent value="android" className="space-y-3 pt-3">
              {canPrompt && (
                <Button className="w-full" onClick={() => void install()}><Download /> Install the app</Button>
              )}
              <ol className="space-y-3">
                {canPrompt && <p className="text-xs text-muted-foreground">Or by hand:</p>}
                <Step n={1}>Open <span className="font-medium">fullfilio.com/admin</span> in <span className="font-medium">Chrome</span>.</Step>
                <Step n={2}>Tap the menu <Key><EllipsisVertical className="size-3.5" /></Key> at the top right.</Step>
                <Step n={3}>Tap <Key><Download className="size-3.5" /> Install app</Key> (on some phones: <span className="font-medium">Add to Home screen</span>).</Step>
                <Step n={4}>Tap <Key>Install</Key>. Fullfilio is now on your Home screen.</Step>
              </ol>
            </TabsContent>
          </Tabs>
        )}

        {showNotifications && <NotificationsPanel />}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}><Check /> Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** In the installed app: one ask to turn new-order notifications on. */
function NotificationsAsk({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const turnOn = async () => {
    setBusy(true)
    try {
      const s = await enablePush()
      if (s === 'on') toast.success('Notifications are on', { description: 'You will hear about every new order on this phone.' })
      else if (s === 'blocked') toast.error('Notifications are blocked', { description: 'You can allow them later in the phone\'s settings for Fullfilio.' })
      onClose()
    } catch (e) {
      toast.error((e as Error).message || 'Something went wrong — please try again')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <span className="mb-1 inline-flex size-10 items-center justify-center rounded-full bg-brand/12 text-brand"><BellRing className="size-5" /></span>
          <DialogTitle>Know about every new order</DialogTitle>
          <DialogDescription>Turn on notifications and every new order shows up on this phone, even when Fullfilio is closed. You can turn them off any time in My account.</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Not now</Button>
          <Button onClick={() => void turnOn()} disabled={busy}><Bell /> Turn on notifications</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Once per device: on a phone or tablet browser, how to install the app; in the installed app,
 * the ask to turn on notifications. Waits until no other popup is open (the update notice).
 */
export function AppOnboarding({ canSeeOrders }: { canSeeOrders: boolean }) {
  const [show, setShow] = useState<'guide' | 'push' | null>(null)
  useEffect(() => {
    const which = isStandalone()
      ? (canSeeOrders && pushSupported() && Notification.permission === 'default' && !flag(PUSH_ASKED) ? 'push' : null)
      : (phonePlatform() !== 'other' && !flag(GUIDE_SEEN) ? 'guide' : null)
    if (!which) return
    let tries = 0
    const timer = window.setInterval(() => {
      tries++
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        if (tries > 20) window.clearInterval(timer)
        return
      }
      window.clearInterval(timer)
      setShow(which)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [canSeeOrders])

  const close = () => {
    setFlag(show === 'push' ? PUSH_ASKED : GUIDE_SEEN)
    setShow(null)
  }
  return (
    <>
      <InstallAppDialog open={show === 'guide'} onOpenChange={(o) => !o && close()} showNotifications={canSeeOrders} />
      <NotificationsAsk open={show === 'push'} onClose={close} />
    </>
  )
}
