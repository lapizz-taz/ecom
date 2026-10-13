import { Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RELEASES } from '@/features/support/releases'

// When a release is marked `major`, every merchant user gets a one-time notice
// the first time they open the admin after it ships — so a big update reaches
// people instead of waiting to be found in the ✨ menu. It is per-browser and
// shows once per major release (keyed by date + title, so two on one day both show).
const KEY = 'admin-major-update-seen'
const latestMajor = RELEASES.find((r) => r.major)
const latestKey = latestMajor ? `${latestMajor.date}|${latestMajor.title}` : ''

/** True when this browser has not yet seen the latest major release (a later date also counts as seen). */
export function majorUnseen(seenValue: string, key = latestKey): boolean {
  if (!key || seenValue === key) return false
  return !(seenValue.split('|')[0] > key.split('|')[0])
}

function seen(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

export function MajorUpdateNotice() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (majorUnseen(seen())) {
      setOpen(true)
    }
  }, [])

  if (!latestMajor) return null

  const dismiss = () => {
    try { localStorage.setItem(KEY, latestKey) } catch { /* private mode */ }
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && dismiss()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <span className="mb-1 inline-flex size-10 items-center justify-center rounded-full bg-brand/12 text-brand"><Sparkles className="size-5" /></span>
          <DialogTitle>We just updated Fullfilio</DialogTitle>
        </DialogHeader>
        <div className="rounded-xl border bg-muted/30 p-3">
          <p className="text-sm font-medium">{latestMajor.title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{latestMajor.body}</p>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" asChild><Link to="/admin/updates" onClick={dismiss}>See all updates</Link></Button>
          {latestMajor.to
            ? <Button asChild onClick={dismiss}><Link to={latestMajor.to}>Take a look</Link></Button>
            : <Button onClick={dismiss}>Got it</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
