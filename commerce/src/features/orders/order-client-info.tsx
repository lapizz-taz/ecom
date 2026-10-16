import { useMutation, useQuery } from '@tanstack/react-query'
import { Ban, Copy, Globe2, Monitor, Smartphone } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth/auth-context'
import { supabase } from '@/lib/supabase'
import { toast } from '@/lib/toast'
import { addBlock } from '@/services/order-tools'

/** "Chrome on Android", "Facebook app on iPhone" … from a browser's user agent. */
export function describeDevice(ua: string | null | undefined): { label: string; mobile: boolean } | null {
  if (!ua) return null
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : null
  const app = /FBAN|FBAV|FB_IAB/.test(ua) ? 'Facebook app' : /Instagram/.test(ua) ? 'Instagram app' : /TikTok|musical_ly|BytedanceWebview/.test(ua) ? 'TikTok app'
    : /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null
  const label = [app, os].filter(Boolean).join(' on ')
  return { label: label || 'Unknown browser', mobile: /Mobile|iPhone|Android|iPad/.test(ua) }
}

/**
 * Where the order was placed from: the visitor's IP address (as our own server or the
 * store's checkout saw it, never what the browser claims) and device, with other orders
 * from the same address and a quick block.
 */
export function OrderClientInfo({ orderId, ip, userAgent }: { orderId: string; ip: string | null; userAgent: string | null }) {
  const { can } = useAuth()
  const [confirm, setConfirm] = useState(false)
  const others = useQuery({
    queryKey: ['orders-from-ip', ip, orderId],
    enabled: !!ip,
    queryFn: async () => {
      const { data, count, error } = await supabase.from('orders').select('id, order_number', { count: 'exact' })
        .eq('client_ip', ip!).neq('id', orderId).order('created_at', { ascending: false }).limit(5)
      if (error) throw error
      return { total: count ?? 0, orders: data ?? [] }
    },
  })
  const block = useMutation({
    mutationFn: (reason: string) => addBlock({ kind: 'IP', value: ip!, reason, orderId }),
    onSuccess: () => toast.success(`New store orders from ${ip} will be held`),
    onError: (e) => toast.error(e),
  })
  const device = describeDevice(userAgent)
  if (!ip && !device) {
    return <p className="text-xs text-muted-foreground">No IP address: the order was entered by staff or came from a store that does not share it.</p>
  }
  return (
    <div className="space-y-1.5 text-sm">
      {ip && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Globe2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-mono text-[13px]">{ip}</span>
          <button type="button" aria-label="Copy IP address" className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => void navigator.clipboard.writeText(ip).then(() => toast.success('IP address copied'), () => undefined)}><Copy className="size-3" /></button>
          {!!others.data?.total && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              {others.data.total} other order{others.data.total === 1 ? '' : 's'} from this IP:{' '}
              {others.data.orders.map((x, i) => (
                <span key={x.id}>{i > 0 && ', '}<Link to={`/admin/orders/${x.id}`} className="hover:underline">{x.order_number}</Link></span>
              ))}
              {others.data.total > others.data.orders.length && ' …'}
            </span>
          )}
          {can('orders.block') && (
            <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs text-muted-foreground" onClick={() => setConfirm(true)}><Ban /> Block IP</Button>
          )}
        </div>
      )}
      {device && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" title={userAgent ?? undefined}>
          {device.mobile ? <Smartphone className="size-3.5" /> : <Monitor className="size-3.5" />} {device.label}
        </p>
      )}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Block ${ip}?`}
        description="New store orders from this address are held for review. Several people can share one mobile network address, so block only when you are sure."
        reason reasonRequired destructive confirmLabel="Block IP" onConfirm={(reason) => block.mutateAsync(reason)} />
    </div>
  )
}
