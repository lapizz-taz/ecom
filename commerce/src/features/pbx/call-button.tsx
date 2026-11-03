import { useMutation } from '@tanstack/react-query'
import { Phone } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { toast } from '@/lib/toast'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth/auth-context'
import { useMerchantFeatures } from '@/features/billing/use-features'
import { usePhone } from '@/features/voicedrive/phone-context'
import { recordCallTap } from '@/services/calls'
import { pbxCall } from '@/services/support'

/**
 * Call a customer. In order of preference: the VoiceDrive browser phone (when
 * this staff member has an extension on an active line), the external PBX's
 * click-to-call, or a normal phone link.
 */
export function CallButton({ phone, orderId, kind, source = 'order', children, ...props }: {
  phone: string; orderId?: string; kind?: 'APPROVED_ORDER' | 'WEB_ORDER'
  /** Where the tap came from, for call tracking (an order's tap is noted; Owner and Admins see it). */
  source?: string
  children?: ReactNode
} & Omit<ComponentProps<typeof Button>, 'onClick' | 'asChild'>) {
  const { access } = useAuth()
  const { isOn } = useMerchantFeatures()
  const vd = usePhone()
  const vdCall = useMutation({
    mutationFn: () => vd.dial({ phone, orderId, kind: kind ?? 'APPROVED_ORDER' }),
    onError: (e) => toast.error((e as Error).message),
  })
  const call = useMutation({
    mutationFn: () => pbxCall(phone, orderId),
    onSuccess: (r) => toast.success(`Ringing your extension ${r.extension}…`, { description: `Pick up to be connected to ${phone}` }),
  })
  const label = children ?? <><Phone /> Call {phone}</>
  const tapped = () => recordCallTap(orderId, source)
  if (vd.canCall) return <Button {...props} disabled={vdCall.isPending || props.disabled} onClick={() => { tapped(); vdCall.mutate() }}>{vdCall.isPending ? <Spinner /> : null}{label}</Button>
  if (!access?.pbx_click_to_call || !isOn('pbx')) return <Button {...props} asChild><a href={`tel:${phone}`} onClick={tapped}>{label}</a></Button>
  return <Button {...props} disabled={call.isPending || props.disabled} onClick={() => { tapped(); call.mutate() }}>{call.isPending ? <Spinner /> : null}{label}</Button>
}
