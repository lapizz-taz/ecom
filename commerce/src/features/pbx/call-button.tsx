import { useMutation } from '@tanstack/react-query'
import { Phone } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { toast } from '@/lib/toast'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth/auth-context'
import { pbxCall } from '@/services/support'

/**
 * Call a customer: through the PBX (it rings your extension first) when
 * click-to-call is set up for you, otherwise a normal phone link.
 */
export function CallButton({ phone, orderId, children, ...props }: { phone: string; orderId?: string; children?: ReactNode } & Omit<ComponentProps<typeof Button>, 'onClick' | 'asChild'>) {
  const { access } = useAuth()
  const call = useMutation({
    mutationFn: () => pbxCall(phone, orderId),
    onSuccess: (r) => toast.success(`Ringing your extension ${r.extension}…`, { description: `Pick up to be connected to ${phone}` }),
  })
  const label = children ?? <><Phone /> Call {phone}</>
  if (!access?.pbx_click_to_call) return <Button {...props} asChild><a href={`tel:${phone}`}>{label}</a></Button>
  return <Button {...props} disabled={call.isPending || props.disabled} onClick={() => call.mutate()}>{call.isPending ? <Spinner /> : null}{label}</Button>
}
