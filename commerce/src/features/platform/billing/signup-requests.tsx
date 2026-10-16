import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageCircle } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { usePlatform } from '@/features/platform/platform-context'
import { formatDateTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { type SignupRequest, signupRequests, updateSignupRequest } from '@/services/platform'

const TONE: Record<SignupRequest['status'], 'info' | 'warning' | 'success' | 'neutral'> = { NEW: 'info', CONTACTED: 'warning', CONVERTED: 'success', DECLINED: 'neutral' }
const LABEL: Record<SignupRequest['status'], string> = { NEW: 'New', CONTACTED: 'Contacted', CONVERTED: 'Opened', DECLINED: 'Declined' }

/** 01XXXXXXXXX → 8801XXXXXXXXX, for a wa.me link to the person. */
const waNumber = (r: SignupRequest) => {
  const n = (r.whatsapp || r.phone).replace(/\D/g, '')
  return n.startsWith('01') ? `88${n}` : n
}

/**
 * Sign-ups by WhatsApp: the details visitors sent before messaging the official
 * number. Nothing exists for them yet; "Open business" starts New merchant with
 * the request filled in, and links the business back to the request.
 */
export function SignupRequests() {
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<'open' | 'all'>('open')
  const list = useQuery({ queryKey: ['platform-signup-requests'], queryFn: () => signupRequests(), refetchInterval: 60_000 })
  const mark = useMutation({
    mutationFn: ({ id, status }: { id: string; status: SignupRequest['status'] }) => updateSignupRequest(id, status),
    onSuccess: (r) => { toast.success(`Marked ${LABEL[r.status].toLowerCase()}`); void queryClient.invalidateQueries({ queryKey: ['platform-signup-requests'] }) },
    onError: (e) => toast.error(e),
  })
  if (list.error) return <ErrorState error={list.error} />
  if (!list.data) return <LoadingState />
  const open = list.data.filter((r) => r.status === 'NEW' || r.status === 'CONTACTED')
  const shown = filter === 'open' ? open : list.data
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3 text-sm">
          <span>Sign-up requests (WhatsApp) {open.length > 0 && <Badge variant="info" className="ml-1">{open.length}</Badge>}</span>
          <span className="flex gap-1 text-xs font-normal">
            {(['open', 'all'] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)}
                className={cn('rounded-md px-2 py-1', filter === f ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {f === 'open' ? 'Open' : 'All'}
              </button>
            ))}
          </span>
        </CardTitle>
        <CardDescription>Visitors who chose to be set up on WhatsApp. They are sent to message the official number with these details; no login or business exists until you open one.</CardDescription>
      </CardHeader>
      <CardContent>
        {shown.length === 0 ? <EmptyState title={filter === 'open' ? 'No open requests' : 'No requests yet'} /> : (
          <ul className="divide-y rounded-xl border text-sm">
            {shown.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{r.business_name} <Badge variant={TONE[r.status]} className="ml-1">{LABEL[r.status]}</Badge>
                    <span className="ml-2 font-mono text-[11px] font-normal text-muted-foreground">ref {r.reference}</span></p>
                  <p className="text-xs text-muted-foreground">
                    {[r.full_name, r.phone, r.whatsapp && r.whatsapp !== r.phone ? `WhatsApp ${r.whatsapp}` : null, r.email, r.business_type,
                      r.orders_per_month ? `${r.orders_per_month} orders/month` : null, r.plan_code ? `plan ${r.plan_code}` : null].filter(Boolean).join(' · ')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(r.created_at)}
                    {r.status === 'CONVERTED' && r.merchant_id && <> · opened as <Link className="underline" to={`/super-admin/merchants/${r.merchant_id}`}>{r.merchant_name ?? 'business'}</Link></>}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button asChild size="sm" variant="ghost">
                    <a href={`https://wa.me/${waNumber(r)}`} target="_blank" rel="noopener noreferrer"><MessageCircle /> Chat</a>
                  </Button>
                  {(r.status === 'NEW' || r.status === 'CONTACTED') && (
                    <>
                      {r.status === 'NEW' && can('merchants', 'edit') && (
                        <Button size="sm" variant="ghost" disabled={mark.isPending} onClick={() => mark.mutate({ id: r.id, status: 'CONTACTED' })}>Contacted</Button>
                      )}
                      {can('merchants', 'edit') && (
                        <Button size="sm" variant="ghost" disabled={mark.isPending} onClick={() => mark.mutate({ id: r.id, status: 'DECLINED' })}>Decline</Button>
                      )}
                      {can('merchants', 'create') && (
                        <Button asChild size="sm" variant="outline"><Link to={`/super-admin/merchants/new?request=${r.id}`}>Open business</Link></Button>
                      )}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
