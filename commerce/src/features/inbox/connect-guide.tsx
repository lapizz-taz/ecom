// The short walk-through shown before Meta's sign-in window opens, so the store
// owner knows what Meta will ask (which Pages, which permissions) before it asks.
import { Briefcase, CheckCircle2, Eye, KeyRound, ListChecks, LogIn, MessageCircle, Phone, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PlatformIcon } from '@/features/inbox/ui'
import { cn } from '@/lib/utils'
import type { MetaConnectKind } from '@/services/inbox'

interface Step { icon: typeof LogIn; title: string; text: string; points: string[] }

const GUIDES: Record<MetaConnectKind, { title: string; steps: Step[] }> = {
  PAGES: {
    title: 'Connect a Facebook Page',
    steps: [
      { icon: LogIn, title: 'Step 1: Log in to Facebook', text: 'A Facebook window opens over Fullfilio. Log in with the account that manages your Page.',
        points: ['Your password goes to Facebook only, never to Fullfilio', 'Allow pop-ups for fullfilio.com if nothing opens'] },
      { icon: ListChecks, title: 'Step 2: Choose your Pages', text: 'Facebook asks which Pages Fullfilio may use.',
        points: ['“Opt in to all current and future Pages” works best', 'Or pick only the Pages you want'] },
      { icon: ShieldCheck, title: 'Step 3: Review permissions and save', text: 'Leave every permission switched on, then press Save.',
        points: ['Messages, comments and the Page list are needed for the inbox', 'Instagram accounts linked to these Pages come along'] },
      { icon: CheckCircle2, title: 'Step 4: Pick what to connect', text: 'Back in Fullfilio, tick the Pages and Instagram accounts for your inbox.',
        points: ['New messages arrive within seconds', 'Disconnect or remove any of them later from this page'] },
    ],
  },
  BUSINESS: {
    title: 'Connect using your business portfolio',
    steps: [
      { icon: Briefcase, title: 'Step 1: Pick your business portfolio', text: 'Log in to Facebook, then choose the business portfolio (Business Manager) that owns your Pages.',
        points: ['Only people with full control of the portfolio can share its Pages'] },
      { icon: ListChecks, title: 'Step 2: Select Pages and Instagram', text: 'Choose the Pages, and their Instagram accounts, to share with Fullfilio.',
        points: ['You can create or add more assets later in Business Settings'] },
      { icon: ShieldCheck, title: 'Step 3: Review and save', text: 'Check the permissions, then confirm.',
        points: ['The connection belongs to the business, not to one person', 'It keeps working when a staff member leaves'] },
      { icon: CheckCircle2, title: 'Step 4: Pick what to connect', text: 'Back in Fullfilio, tick what goes into the inbox.', points: [] },
    ],
  },
  WHATSAPP: {
    title: 'Connect a WhatsApp number',
    steps: [
      { icon: LogIn, title: 'Step 1: Log in to Facebook', text: 'Use the account that manages your WhatsApp Business account.', points: [] },
      { icon: Phone, title: 'Step 2: Choose or add a number', text: 'Pick your WhatsApp Business account and phone number, or add a new one.',
        points: ['A number used in the WhatsApp Business app can be moved here'] },
      { icon: KeyRound, title: 'Step 3: Verify the number', text: 'Meta sends a code by SMS or call to confirm the number.', points: [] },
      { icon: MessageCircle, title: 'Step 4: Start replying', text: 'Messages to the number arrive in the inbox.', points: [] },
    ],
  },
}

const SKIP_KEY = 'fullfilio:meta-guide-skip'
export function guideSkipped(): boolean {
  try { return localStorage.getItem(SKIP_KEY) === '1' } catch { return false }
}

/** The guide for one way of connecting. onConnect must open Meta's window straight away (it runs from a click). */
export function ConnectGuide({ kind, onClose, onConnect }: { kind: MetaConnectKind | null; onClose: () => void; onConnect: (kind: MetaConnectKind) => void }) {
  const [step, setStep] = useState(0)
  const [skipNext, setSkipNext] = useState(false)
  if (!kind) return null
  const guide = GUIDES[kind]
  const s = guide.steps[step]
  const last = step === guide.steps.length - 1
  const go = () => {
    if (skipNext) { try { localStorage.setItem(SKIP_KEY, '1') } catch { /* private window */ } }
    onConnect(kind)
    setStep(0)
  }
  const close = () => { setStep(0); onClose() }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{guide.title}</DialogTitle>
          <DialogDescription>{s.title}</DialogDescription>
        </DialogHeader>
        <div className="rounded-[10px] border bg-muted/40 p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[#1877F2]/10 text-[#1877F2]"><s.icon className="size-5" /></span>
            <div className="min-w-0 space-y-2">
              <p className="text-sm">{s.text}</p>
              {s.points.length > 0 && (
                <ul className="space-y-1">
                  {s.points.map((p) => <li key={p} className="flex gap-1.5 text-xs text-muted-foreground"><Eye className="mt-0.5 size-3 shrink-0" />{p}</li>)}
                </ul>
              )}
            </div>
          </div>
        </div>
        <div className="flex justify-center gap-1.5" aria-label={`Step ${step + 1} of ${guide.steps.length}`}>
          {guide.steps.map((g, i) => (
            <button key={g.title} type="button" aria-label={g.title} onClick={() => setStep(i)}
              className={cn('h-1.5 rounded-full transition-all', i === step ? 'w-5 bg-foreground' : 'w-1.5 bg-muted-foreground/30')} />
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={skipNext} onCheckedChange={(v) => setSkipNext(v === true)} /> Don’t show these steps again
        </label>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={go}>Skip &amp; connect</Button>
          {last
            ? <Button className="bg-[#1877F2] text-white hover:bg-[#1877F2]/90" onClick={go}><PlatformIcon platform="FACEBOOK" className="size-4 brightness-0 invert" /> Continue with Facebook</Button>
            : <Button onClick={() => setStep(step + 1)}>Next step</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
