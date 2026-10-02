import type { ReactNode } from 'react'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PAYMENT_CHANNEL } from '@/lib/status'
import type { Enums } from '@/types/database'

/** Dialog with a form body, Cancel/Submit footer and a busy state that blocks closing. */
export function FormDialog({ open, onOpenChange, title, description, children, submitLabel, onSubmit, busy, disabled, wide, destructive }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: ReactNode
  children: ReactNode
  submitLabel: string
  onSubmit: () => void
  busy?: boolean
  disabled?: boolean
  wide?: boolean
  destructive?: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className={wide ? 'sm:max-w-2xl' : undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
          {children}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={busy || disabled}>{busy && <Spinner />} {submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export type PaymentChannel = Enums<'payment_channel'>
export const PAYMENT_CHANNELS = Object.keys(PAYMENT_CHANNEL) as PaymentChannel[]

export function ChannelSelect({ value, onChange, id, allowNone }: { value: PaymentChannel | null; onChange: (v: PaymentChannel | null) => void; id?: string; allowNone?: boolean }) {
  return (
    <Select value={value ?? 'none'} onValueChange={(v) => onChange(v === 'none' ? null : (v as PaymentChannel))}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value="none">Not specified</SelectItem>}
        {PAYMENT_CHANNELS.map((c) => <SelectItem key={c} value={c}>{PAYMENT_CHANNEL[c]}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}
