import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, Ban, Check, Copy, CreditCard, ExternalLink, Factory, FileText, Layers, MessageCircle, MoreHorizontal, Package, PackageMinus,
  PackageX, Pencil, Phone, PhoneCall, Printer, RefreshCw, ShieldAlert, ShieldCheck, Tag, Truck, Undo2, Wallet, X,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { Can } from '@/components/common/permission-gate'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Money } from '@/components/common/money'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge, type BadgeVariant } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { CourierHistoryTable, courierHistoryOf } from '@/features/fraud/courier-history'
import {
  AssignCourierDialog, EditItemsDialog, EditOrderDialog, FraudDecisionDialog, PartialDeliveryDialog, RecordPaymentDialog, RefundDialog,
  RetainAdvanceDialog, ReturnDialog, ShipmentStatusDialog,
} from '@/features/orders/order-dialogs'
import { OrderSourceCard } from '@/features/orders/order-source-card'
import { waNumber } from '@/features/storefront/whatsapp-confirm'
import { formatDateTime, formatMoney, formatNumber, formatPercent, titleCase, toNumber } from '@/lib/format'
import {
  ADVANCE_TYPE, CANCEL_VIA_COURIER, CANCELLABLE, CHARGE_KIND, CHARGE_SOURCE, EDITABLE, FRAUD_DECISION, FRAUD_STATUS, LOSABLE, NEEDS_REASON, NEXT_ACTIONS, ORDER_STATUS,
  PAYMENT_CHANNEL, PAYMENT_METHOD, PAYMENT_STATUS, PRODUCTION_STATUS, RECEIVABLE, RISK_LEVEL, SEGMENT, SHIPMENT_STATUS, STAGE, stageOf,
} from '@/lib/status'
import { cn } from '@/lib/utils'
import { imageUrl } from '@/services/catalog'
import {
  addOrderNote, approveOrders, dismissDuplicate, duplicateOrder, fraudReviewDecide, getOrder, getOrderBrief, listReviewStatuses, mergeOrders,
  checkGatewayPayment, type OrderDetail, runFraudCheck, setWebOrderStatus, transitionOrder, verifyManualPayment,
} from '@/services/orders'
import type { OrderStatus } from '@/types/domain'

type DialogName = 'payment' | 'refund' | 'retain' | 'courier' | 'shipment' | 'edit' | 'items' | 'return' | 'partial' | null

const GATEWAY_NAME: Record<string, string> = { bkash: 'bKash', paystation: 'PayStation' }

const EVENT_LABEL: Record<string, string> = {
  REVIEW_STATUS: 'Call',
  FROM_INCOMPLETE_CHECKOUT: 'Created from an incomplete checkout',
  PARTIAL_RECORDED: 'Partial delivery recorded',
  PARTIAL_RETURN_RECEIVED: 'Items sent back received',
  PARCEL_LOST: 'Parcel lost',
  PICKED_UP_DESPITE_CANCEL: 'Picked up before the cancel',
}
type FraudAction = 'APPROVE' | 'REQUEST_ADVANCE' | 'REJECT'

function Row({ label, value, strong, muted, className }: { label: ReactNode; value: ReactNode; strong?: boolean; muted?: boolean; className?: string }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 text-sm', strong && 'font-semibold', className)}>
      <dt className={cn(!strong && 'text-muted-foreground')}>{label}</dt>
      <dd className={cn('text-right tabular-nums', muted && 'text-muted-foreground')}>{value}</dd>
    </div>
  )
}

export default function OrderDetailPage() {
  const { id = '' } = useParams()
  const { can } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const order = useQuery({ queryKey: ['order', id], queryFn: () => getOrder(id) })
  const [dialog, setDialog] = useState<DialogName>(null)
  const [transitionTo, setTransitionTo] = useState<OrderStatus | null>(null)
  const [fraudAction, setFraudAction] = useState<FraudAction | null>(null)
  const [confirmMerge, setConfirmMerge] = useState(false)
  const duplicateOf = order.data?.duplicate_status === 'SUSPECTED' ? order.data.duplicate_of : order.data?.merged_into
  const related = useQuery({ queryKey: ['order-brief', duplicateOf], enabled: !!duplicateOf, queryFn: () => getOrderBrief(duplicateOf!) })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['order', id] })
    void queryClient.invalidateQueries({ queryKey: ['orders'] })
  }

  const transition = useMutation({
    mutationFn: ({ to, note }: { to: OrderStatus; note: string }) => transitionOrder(id, to, note),
    onSuccess: (_d, v) => { toast.success(`Order moved to ${ORDER_STATUS[v.to].label}`); refresh() },
  })
  const approve = useMutation({
    mutationFn: () => approveOrders([id]),
    onSuccess: (r) => {
      if (r.approved) toast.success('Approved — it is now in Approved Orders')
      else toast.error(r.failed[0]?.error.replace(/^[A-Z_]+: /, '') ?? 'Could not approve this order')
      refresh()
    },
  })
  const fraudCheck = useMutation({
    mutationFn: () => runFraudCheck(id, true),
    onSuccess: () => { toast.success('Fraud check completed'); refresh() },
  })
  const duplicate = useMutation({
    mutationFn: () => duplicateOrder(id),
    onSuccess: (o) => { toast.success(`Created ${o?.order_number}`); navigate(`/admin/orders/${o?.id}`) },
  })
  const merge = useMutation({
    mutationFn: () => mergeOrders(id, related.data!.id),
    onSuccess: () => { toast.success(`Merged into ${related.data?.order_number}`); refresh(); navigate(`/admin/orders/${related.data!.id}`) },
  })
  const dismiss = useMutation({
    mutationFn: () => dismissDuplicate(id),
    onSuccess: () => { toast.success('Marked as not a duplicate'); refresh() },
  })
  const verify = useMutation({
    mutationFn: ({ paymentId, approve }: { paymentId: string; approve: boolean }) => verifyManualPayment(paymentId, approve, approve ? 'Verified against statement' : 'Not found in statement'),
    onSuccess: (_d, v) => { toast.success(v.approve ? 'Payment verified' : 'Payment rejected'); refresh() },
  })

  const checkGateway = useMutation({
    mutationFn: (paymentId: string) => checkGatewayPayment(paymentId),
    onSuccess: ({ status }) => {
      const messages: Record<string, string> = {
        succeeded: 'Payment confirmed by the gateway', already_succeeded: 'Payment was already confirmed',
        pending: 'Not paid yet — the gateway is still waiting for the customer', failed: 'The gateway reports this payment failed',
        amount_mismatch: 'Paid, but the amount does not match — held for review',
      }
      toast[status === 'succeeded' || status === 'already_succeeded' ? 'success' : 'info'](messages[status] ?? `Gateway answered: ${status.replace(/_/g, ' ')}`)
      refresh()
    },
  })

  if (order.isLoading) return <LoadingState />
  if (order.error) return <ErrorState error={order.error} onRetry={() => order.refetch()} />
  if (!order.data) return <ErrorState error={new Error('NOT_FOUND: Order not found')} />
  const o = order.data
  const status = o.status as OrderStatus
  const shipment = o.shipments.find((s) => s.is_active)
  const production = o.production_orders.find((p) => p.status !== 'CANCELLED')
  const pendingVerification = o.payments.filter((p) => p.status === 'REQUIRES_VERIFICATION')
  const inReview = ['FRAUD_REVIEW', 'ADVANCE_REQUIRED', 'REJECTED_FRAUD', 'CONFIRMATION_REQUIRED', 'PENDING', 'FRAUD_CHECK'].includes(status)
  const unresolvedAdvance = ['CANCELLED', 'REJECTED_FRAUD', 'RETURNED', 'FAILED_DELIVERY'].includes(status) && !o.delivered_at
    && toNumber(o.amount_paid) > 0 && !o.advance_resolution
  const partialBack = toNumber(o.partial_return_amount)
  const remainingCod = Math.max(toNumber(o.total_amount) - partialBack - toNumber(o.amount_paid), 0)
  const stage = stageOf(status, o.confirmed_at)
  const isWeb = stage === 'WEB'
  const closed = ['CANCELLED', 'REJECTED_FRAUD'].includes(status)
  const canReceive = RECEIVABLE.includes(status) && (status !== 'PENDING_CANCEL' || !!o.shipped_at)
  const canPartial = ['SHIPPED', 'FAILED_DELIVERY'].includes(status) || (status === 'PARTIALLY_DELIVERED' && partialBack === 0)
  const courierHasIt = CANCEL_VIA_COURIER.includes(status) && !!shipment && (status === 'SHIPPED' || !!shipment.tracking_number)
  const history = [...o.order_status_history].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const notes = [...o.order_notes].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const fc = o.fraud_check
  // Approval lives on the call card for web orders.
  const next = (NEXT_ACTIONS[status] ?? []).filter((a) => a.to !== 'CONFIRMED')

  return (
    <div className="space-y-4">
      <div className="no-print">
        <Link to={isWeb ? '/admin/orders/web' : '/admin/orders/approved'} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> {isWeb ? 'Web orders' : 'Approved orders'}
        </Link>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{o.order_number}</h1>
            {isWeb ? <Badge variant="outline">Web order</Badge> : <StatusBadge value={stage} map={STAGE} />}
            {(isWeb || STAGE[stage].label !== ORDER_STATUS[status].label) && <StatusBadge value={status} map={ORDER_STATUS} />}
            <StatusBadge value={o.payment_status} map={PAYMENT_STATUS} />
            <StatusBadge value={o.fraud_status} map={FRAUD_STATUS} />
            {o.source === 'ADMIN' && <Badge variant="outline">Manual order</Badge>}
            {o.label_printed_at
              ? <Badge variant="success" className="gap-1" title={formatDateTime(o.label_printed_at)}><Tag className="size-3" /> Label printed{o.label_print_count > 1 ? ` ${o.label_print_count}×` : ''}</Badge>
              : <Badge variant="neutral" className="gap-1"><Tag className="size-3" /> Label not printed</Badge>}
            {o.merged_count > 0 && <Badge variant="info" className="gap-1"><Layers className="size-3" /> {o.merged_count} checkout{o.merged_count === 1 ? '' : 's'} merged in</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">
            {formatDateTime(o.created_at)} · {o.customer_name} · {PAYMENT_METHOD[o.payment_method]}
            {o.attribution && o.attribution.channel !== 'unknown' && <> · from <span className="font-medium text-foreground">{o.attribution.source}</span>{o.attribution.campaign && <> · {o.attribution.campaign}</>}</>}
          </p>
        </div>
        <div className="no-print flex flex-wrap items-center gap-2">
          {can('orders.fulfill') && !['CANCELLED', 'REJECTED_FRAUD'].includes(status) && (
            <Button size="sm" variant="outline" asChild><Link to={`/admin/labels?ids=${o.id}`}><Printer /> {o.label_printed_at ? 'Reprint label' : 'Print label'}</Link></Button>
          )}
          {can('orders.status') && next.map((a) => (
            <Button key={a.to} size="sm" variant={a === next[0] ? 'default' : 'outline'} disabled={transition.isPending}
              onClick={() => (NEEDS_REASON.includes(a.to) ? setTransitionTo(a.to) : transition.mutate({ to: a.to, note: '' }))}>
              {transition.isPending && transition.variables?.to === a.to ? <Spinner /> : <Check />} {a.label}
            </Button>
          ))}
          {can('orders.status') && canReceive && (
            <Button size="sm" onClick={() => setDialog('return')}><Undo2 /> {status === 'PARTIALLY_DELIVERED' ? 'Receive items sent back' : 'Receive return'}</Button>
          )}
          {can('orders.cancel') && courierHasIt ? (
            <Button size="sm" variant="outline" onClick={() => setTransitionTo('PENDING_CANCEL')}><Ban /> Ask courier to cancel</Button>
          ) : can('orders.cancel') && CANCELLABLE.includes(status) && (
            <Button size="sm" variant="outline" onClick={() => setTransitionTo('CANCELLED')}><Ban /> Cancel</Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="icon-sm" variant="outline" aria-label="More actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {can('orders.update') && EDITABLE.includes(status) && (
                <>
                  <DropdownMenuItem onClick={() => setDialog('edit')}><Pencil /> Edit order</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setDialog('items')}><Package /> Edit items</DropdownMenuItem>
                </>
              )}
              <DropdownMenuItem asChild><Link to={`/admin/orders/${o.id}/invoice`}><FileText /> Print invoice</Link></DropdownMenuItem>
              <DropdownMenuItem asChild><Link to={`/admin/orders/${o.id}/packing-slip`}><Printer /> Packing slip</Link></DropdownMenuItem>
              {can('orders.create') && <DropdownMenuItem onClick={() => duplicate.mutate()}><Copy /> Duplicate order</DropdownMenuItem>}
              {can('fraud.review') && inReview && <DropdownMenuItem onClick={() => fraudCheck.mutate()}><RefreshCw /> Re-run fraud check</DropdownMenuItem>}
              {can('orders.status') && (canPartial || status === 'SHIPPED' || LOSABLE.includes(status)) && <DropdownMenuSeparator />}
              {can('orders.status') && canPartial && (
                <DropdownMenuItem onClick={() => setDialog('partial')}><PackageMinus /> Partial delivery…</DropdownMenuItem>
              )}
              {can('orders.status') && (status === 'SHIPPED' || (status === 'PENDING_CANCEL' && o.shipped_at)) && (
                <DropdownMenuItem onClick={() => transition.mutate({ to: 'RETURNING', note: '' })}><Undo2 /> Parcel coming back</DropdownMenuItem>
              )}
              {can('orders.status') && LOSABLE.includes(status) && (
                <DropdownMenuItem onClick={() => setTransitionTo('LOST')}><PackageX /> Lost by courier…</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {isWeb && !closed && <CallOutcomeCard order={o} onChanged={refresh} onApprove={() => approve.mutate()} approving={approve.isPending} />}

      {o.duplicate_status === 'SUSPECTED' && related.data && (
        <Card className="border-amber-300 bg-amber-50/60">
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3 text-sm">
              <Copy className="mt-0.5 size-5 text-amber-600" />
              <div>
                <p className="font-medium">Possible duplicate of <Link to={`/admin/orders/${related.data.id}`} className="font-mono underline">{related.data.order_number}</Link></p>
                <p className="text-muted-foreground">
                  {related.data.customer_name} · <Money value={related.data.total_amount} /> · {formatDateTime(related.data.created_at)} · {ORDER_STATUS[related.data.status as OrderStatus].label}
                </p>
              </div>
            </div>
            {can('orders.update') && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setConfirmMerge(true)}><Layers /> Merge into {related.data.order_number}</Button>
                <Button size="sm" variant="outline" onClick={() => dismiss.mutate()} disabled={dismiss.isPending}><X /> Not a duplicate</Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {o.merged_into && related.data && (
        <Card className="border-sky-300 bg-sky-50/60">
          <CardContent className="flex items-center gap-3 text-sm">
            <Layers className="size-5 text-sky-600" />
            <p>This order was merged into <Link to={`/admin/orders/${related.data.id}`} className="font-mono font-medium underline">{related.data.order_number}</Link> — ship that order instead.</p>
          </CardContent>
        </Card>
      )}
      <ConfirmDialog
        open={confirmMerge}
        onOpenChange={setConfirmMerge}
        title={`Merge ${o.order_number} into ${related.data?.order_number ?? ''}?`}
        description="All items move to the other order (one parcel, one delivery charge) and this order is cancelled as merged. The customer is not sent a cancellation message."
        confirmLabel="Merge orders"
        onConfirm={() => merge.mutateAsync()}
      />

      {can('fraud.review') && ['FRAUD_REVIEW', 'ADVANCE_REQUIRED', 'REJECTED_FRAUD'].includes(status) && (
        <Card className="border-amber-300 bg-amber-50/50">
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3 text-sm">
              <ShieldAlert className="mt-0.5 size-5 text-amber-600" />
              <div>
                <p className="font-medium">{status === 'ADVANCE_REQUIRED' ? `Waiting for an advance of ${formatMoney(Math.max(toNumber(o.advance_required) - toNumber(o.amount_paid), 0))}` : status === 'REJECTED_FRAUD' ? 'Rejected by fraud rules' : 'Needs a fraud review decision'}</p>
                <p className="text-muted-foreground">{fc?.recommendation ?? 'Review the risk analysis below and decide.'}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setFraudAction('APPROVE')}><ShieldCheck /> Approve</Button>
              <Button size="sm" variant="outline" onClick={() => setFraudAction('REQUEST_ADVANCE')}><Wallet /> Request advance</Button>
              {status !== 'REJECTED_FRAUD' && <Button size="sm" variant="destructive" onClick={() => setFraudAction('REJECT')}><X /> Reject</Button>}
            </div>
          </CardContent>
        </Card>
      )}

      {pendingVerification.length > 0 && can('payments.verify') && (
        <Card className="border-sky-300">
          <CardHeader><CardTitle className="text-sm">Customer reported a payment — verify it against your statement</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {pendingVerification.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
                <div>
                  <p className="font-medium"><Money value={p.amount} /> via {PAYMENT_CHANNEL[p.channel]} · TrxID <span className="font-mono">{p.provider_transaction_id}</span></p>
                  <p className="text-muted-foreground">From {p.payer_phone ?? '—'} · {formatDateTime(p.created_at)}{p.failure_reason ? ` · ${p.failure_reason}` : ''}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => verify.mutate({ paymentId: p.id, approve: true })} disabled={verify.isPending}><Check /> Verified</Button>
                  <Button size="sm" variant="outline" onClick={() => verify.mutate({ paymentId: p.id, approve: false })} disabled={verify.isPending}><X /> Not received</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Products</CardTitle>
              {can('orders.update') && EDITABLE.includes(status) && <CardAction><Button size="sm" variant="ghost" onClick={() => setDialog('items')}><Pencil /> Edit</Button></CardAction>}
            </CardHeader>
            <CardContent>
              <ul className="divide-y">
                {o.order_items.map((i) => (
                  <li key={i.id} className="flex gap-3 py-2.5 first:pt-0">
                    {i.image_url ? <img src={imageUrl(i.image_url, 120)} alt="" className="size-12 rounded-md bg-muted object-cover" /> : <div className="size-12 rounded-md bg-muted" />}
                    <div className="min-w-0 flex-1 text-sm">
                      <Link to={`/admin/products/${i.product_id}`} className="font-medium hover:underline">{i.product_name}</Link>
                      <p className="text-muted-foreground">{i.variant_title ? `${i.variant_title} · ` : ''}{i.sku}{i.requires_production && ' · made to order'}</p>
                      {(i.returned_quantity > 0 || i.damaged_quantity > 0) && (
                        <p className="text-xs text-amber-700">Returned {i.returned_quantity}{i.damaged_quantity ? ` · damaged ${i.damaged_quantity}` : ''}</p>
                      )}
                    </div>
                    <div className="text-right text-sm tabular-nums">
                      <p>{formatMoney(i.unit_price)} × {i.quantity}</p>
                      {toNumber(i.discount_amount) > 0 && <p className="text-xs text-muted-foreground">−{formatMoney(i.discount_amount)}</p>}
                      <p className="font-medium">{formatMoney(i.line_total)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-sm">Pricing</CardTitle></CardHeader>
              <CardContent>
                <dl className="space-y-1.5">
                  <Row label="Products subtotal" value={formatMoney(o.subtotal)} />
                  {toNumber(o.coupon_discount) > 0 && <Row label={`Coupon ${o.coupon_code ?? ''}`} value={`−${formatMoney(o.coupon_discount)}`} />}
                  {toNumber(o.manual_discount) > 0 && <Row label="Discount" value={`−${formatMoney(o.manual_discount)}`} />}
                  <Row label={`Delivery${o.delivery_zone ? ` (${o.delivery_zone.name})` : ''}`} value={formatMoney(o.delivery_charge)} />
                  {toNumber(o.delivery_discount) > 0 && <Row label="Free delivery" value={`−${formatMoney(o.delivery_discount)}`} />}
                  <Row label="Order total" value={formatMoney(o.total_amount)} strong className="border-t pt-1.5" />
                  {partialBack > 0 && <Row label="Sent back (partial delivery)" value={`−${formatMoney(partialBack)}`} />}
                  {toNumber(o.advance_required) > 0 && <Row label={`Advance required (${ADVANCE_TYPE[o.advance_type]})`} value={formatMoney(o.advance_required)} muted />}
                  <Row label="Paid" value={toNumber(o.amount_paid) > 0 ? `−${formatMoney(o.amount_paid)}` : formatMoney(0)} />
                  {toNumber(o.amount_refunded) > 0 && <Row label="Refunded" value={formatMoney(o.amount_refunded)} muted />}
                  <Row label="Remaining COD" value={formatMoney(remainingCod)} strong className="border-t pt-1.5" />
                </dl>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Financial summary</CardTitle></CardHeader>
              <CardContent>
                {can('finance.view') || can('orders.price_override') ? (
                  <dl className="space-y-1.5">
                    <Row label="Product revenue" value={formatMoney(toNumber(o.subtotal) - toNumber(o.discount_total))} />
                    <Row label="Delivery income" value={formatMoney(toNumber(o.delivery_charge) - toNumber(o.delivery_discount))} />
                    <Row label="Cost of goods" value={`−${formatMoney(o.cost_total)}`} />
                    <Row label="Gross profit" value={formatMoney(toNumber(o.total_amount) - toNumber(o.cost_total))} strong className="border-t pt-1.5" />
                    {shipment && <Row label="Courier cost" value={`−${formatMoney(shipment.shipping_cost)}`} />}
                    {shipment && toNumber(shipment.return_charge) > 0 && ['RETURNED', 'FAILED_DELIVERY'].includes(status) && <Row label="Return charge" value={`−${formatMoney(shipment.return_charge)}`} />}
                    <Row label="Contribution" strong className="border-t pt-1.5"
                      value={formatMoney(toNumber(o.total_amount) - toNumber(o.cost_total) - toNumber(shipment?.shipping_cost))} />
                    <p className="pt-1 text-xs text-muted-foreground">Revenue and cost post to the ledger automatically when the order is delivered.</p>
                  </dl>
                ) : <p className="text-sm text-muted-foreground">Costs are visible to finance staff.</p>}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Payments</CardTitle>
              <CardAction className="flex gap-1">
                {can('payments.record') && remainingCod > 0 && !['CANCELLED', 'REJECTED_FRAUD'].includes(status) && (
                  <Button size="sm" variant="ghost" onClick={() => setDialog('payment')}><CreditCard /> Record payment</Button>
                )}
                {can('refunds.manage') && toNumber(o.amount_paid) > 0 && o.advance_resolution !== 'RETAINED' && (
                  <Button size="sm" variant="ghost" onClick={() => setDialog('refund')}><Undo2 /> Refund</Button>
                )}
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-3">
              {unresolvedAdvance && can('refunds.manage') && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 p-3 text-sm">
                  <span><Money value={o.amount_paid} /> was paid on an order that won't be delivered. Refund it or keep it.</span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setDialog('refund')}>Refund</Button>
                    <Button size="sm" variant="outline" onClick={() => setDialog('retain')}>Keep as income</Button>
                  </div>
                </div>
              )}
              {o.order_payments.length === 0 && o.payments.length === 0 ? <p className="text-sm text-muted-foreground">No payments yet.</p> : (
                <ul className="divide-y text-sm">
                  {[...o.order_payments].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((p) => (
                    <li key={p.id} className="flex justify-between gap-3 py-2">
                      <div>
                        <p className="font-medium">{titleCase(p.kind)} · {PAYMENT_CHANNEL[p.channel]}</p>
                        <p className="text-xs text-muted-foreground">{formatDateTime(p.created_at)}{p.reference ? ` · ${p.reference}` : ''}{p.note ? ` · ${p.note}` : ''}</p>
                      </div>
                      <Money value={p.kind === 'REFUND' ? -p.amount : p.amount} className={cn('font-medium', p.kind === 'REFUND' && 'text-red-600')} />
                    </li>
                  ))}
                  {o.payments.filter((p) => !['SUCCEEDED', 'REQUIRES_VERIFICATION'].includes(p.status)).map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-muted-foreground">
                      <span className="min-w-0">{GATEWAY_NAME[p.provider] ?? p.provider} attempt · {titleCase(p.status)}{p.failure_reason ? ` · ${p.failure_reason}` : ''}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        {GATEWAY_NAME[p.provider] && can('payments.verify')
                          && (p.status === 'PENDING' || (p.status === 'FAILED' && !o.payments.some((x) => x.status === 'SUCCEEDED'))) && (
                          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={checkGateway.isPending} onClick={() => checkGateway.mutate(p.id)}>
                            {checkGateway.isPending && checkGateway.variables === p.id ? <Spinner /> : <RefreshCw />} Check with {GATEWAY_NAME[p.provider]}
                          </Button>
                        )}
                        <Money value={p.amount} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Courier</CardTitle>
              {can('shipments.manage') && !['CANCELLED', 'REJECTED_FRAUD', 'DELIVERED', 'RETURNED'].includes(status) && (
                <CardAction className="flex gap-1">
                  {shipment && <Button size="sm" variant="ghost" onClick={() => setDialog('shipment')}><RefreshCw /> Update status</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setDialog('courier')}><Truck /> {shipment ? 'Change' : 'Assign courier'}</Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent>
              {!shipment ? <p className="text-sm text-muted-foreground">No courier assigned yet.</p> : (
                <div className="space-y-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{shipment.couriers?.name}</span>
                    <StatusBadge value={shipment.status} map={SHIPMENT_STATUS} />
                    {shipment.tracking_number && <span className="font-mono">{shipment.tracking_number}</span>}
                    {shipment.couriers?.tracking_url_template && shipment.tracking_number && (
                      <a href={shipment.couriers.tracking_url_template.replace('{tracking}', shipment.tracking_number)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
                        Track <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                    <div><dt className="text-xs text-muted-foreground">Shipping cost</dt><dd><Money value={shipment.shipping_cost} /></dd></div>
                    <div><dt className="text-xs text-muted-foreground">COD to collect</dt><dd><Money value={shipment.cod_amount} /></dd></div>
                    <div><dt className="text-xs text-muted-foreground">COD collected</dt><dd><Money value={shipment.cod_collected} /></dd></div>
                    <div><dt className="text-xs text-muted-foreground">Delivered</dt><dd>{formatDateTime(shipment.delivered_at)}</dd></div>
                  </dl>
                  <CourierCharges charges={shipment.shipment_charges} />
                  {shipment.shipment_events.length > 0 && (
                    <ul className="space-y-1 border-l pl-3 text-xs">
                      {[...shipment.shipment_events].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)).map((e) => (
                        <li key={e.id}><span className="font-medium">{SHIPMENT_STATUS[e.status].label}</span> · {e.description ?? ''} <span className="text-muted-foreground">{formatDateTime(e.occurred_at)} · {titleCase(e.source)}</span></li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {production && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Production</CardTitle>
                <CardAction><Button size="sm" variant="ghost" asChild><Link to={`/admin/production/${production.id}`}><Factory /> Open</Link></Button></CardAction>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-3 text-sm">
                <StatusBadge value={production.status} map={PRODUCTION_STATUS} />
                <span className="text-muted-foreground">Priority {titleCase(production.priority)} · deadline {production.deadline ?? '—'}</span>
                {production.rejection_count > 0 && <Badge variant="warning">QC rejected {production.rejection_count}×</Badge>}
              </CardContent>
            </Card>
          )}

          <NotesCard orderId={o.id} notes={notes} onAdded={refresh} canAdd={can('orders.update')} phone={o.customer_phone} />

          <Card>
            <CardHeader><CardTitle className="text-sm">Timeline</CardTitle></CardHeader>
            <CardContent>
              <ol className="space-y-3 border-l pl-4">
                {history.map((h) => (
                  <li key={h.id} className="relative text-sm">
                    <span className={cn('absolute top-1.5 -left-[21px] size-2 rounded-full', h.to_status ? 'bg-foreground' : 'bg-muted-foreground/50')} />
                    <p className="font-medium">
                      {h.to_status ? <>{h.from_status ? `${ORDER_STATUS[h.from_status as OrderStatus].label} → ` : ''}{ORDER_STATUS[h.to_status as OrderStatus].label}</> : EVENT_LABEL[h.event] ?? titleCase(h.event)}
                    </p>
                    {h.message && <p className="text-muted-foreground">{h.message}</p>}
                    <p className="text-xs text-muted-foreground">{formatDateTime(h.created_at)} · {h.actor_name ?? 'System'}</p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Customer</CardTitle>
              <CardAction><Button size="sm" variant="ghost" asChild><Link to={`/admin/customers/${o.customer_id}`}>View</Link></Button></CardAction>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <p className="font-medium">{o.customer_name}</p>
                <a href={`tel:${o.customer_phone}`} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"><Phone className="size-3" /> {o.customer_phone}</a>
                {o.customer_email && <p className="text-muted-foreground">{o.customer_email}</p>}
              </div>
              {o.customer && (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    <StatusBadge value={o.customer.segment} map={SEGMENT} />
                    {o.customer.status === 'BLOCKED' && <Badge variant="destructive">Blocked</Badge>}
                  </div>
                  <dl className="grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-md bg-muted/50 p-2"><dt className="text-xs text-muted-foreground">Orders</dt><dd className="font-medium">{o.customer.total_orders}</dd></div>
                    <div className="rounded-md bg-muted/50 p-2"><dt className="text-xs text-muted-foreground">Delivered</dt><dd className="font-medium">{o.customer.delivered_orders}</dd></div>
                    <div className="rounded-md bg-muted/50 p-2"><dt className="text-xs text-muted-foreground">Failed/ret.</dt><dd className="font-medium">{o.customer.failed_deliveries + o.customer.returned_orders}</dd></div>
                  </dl>
                  <p className="text-xs text-muted-foreground">Lifetime spend <Money value={o.customer.total_spent} /> · cancelled {o.customer.cancelled_orders}</p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Shipping</CardTitle>
              {can('orders.update') && EDITABLE.includes(status) && <CardAction><Button size="sm" variant="ghost" onClick={() => setDialog('edit')}><Pencil /> Edit</Button></CardAction>}
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p>{o.shipping_address}</p>
              <p className="text-muted-foreground">{[o.shipping_area, o.shipping_city, o.shipping_district, o.shipping_postal_code].filter(Boolean).join(', ')}</p>
              <p className="text-muted-foreground">Method: {titleCase(o.delivery_method)}</p>
              {o.customer_note && <p className="mt-2 rounded-md bg-muted/60 p-2"><span className="font-medium">Customer note:</span> {o.customer_note}</p>}
            </CardContent>
          </Card>

          <OrderSourceCard orderId={o.id} attribution={o.attribution} orderStatus={status} />

          <Can permission="fraud.view">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Fraud analysis</CardTitle>
                {can('fraud.review') && (
                  <CardAction><Button size="sm" variant="ghost" onClick={() => fraudCheck.mutate()} disabled={fraudCheck.isPending}>{fraudCheck.isPending ? <Spinner /> : <RefreshCw />} Re-check</Button></CardAction>
                )}
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {!fc ? <p className="text-muted-foreground">No fraud check recorded.</p> : (
                  <>
                    <div className="flex items-center gap-2">
                      <StatusBadge value={fc.risk_level} map={RISK_LEVEL} />
                      <span className="text-muted-foreground">score {formatNumber(fc.risk_score, 1)} / 100</span>
                      <StatusBadge value={o.fraud_decision} map={FRAUD_DECISION} />
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                      <Row label="Courier score" value={fc.courier_score !== null ? formatPercent(fc.courier_score) : '—'} />
                      <Row label="Past orders" value={fc.previous_orders} />
                      <Row label="Delivered" value={fc.delivered_orders} />
                      <Row label="Cancelled" value={fc.cancelled_orders} />
                      <Row label="Returned" value={fc.returned_orders} />
                      <Row label="Failed" value={fc.failed_delivery_orders} />
                      <Row label="Cancel rate" value={formatPercent(fc.cancellation_rate)} />
                      <Row label="Fail rate" value={formatPercent(fc.failed_delivery_rate)} />
                    </dl>
                    {courierHistoryOf(fc.provider_response) && (
                      <div className="border-t pt-3">
                        <p className="mb-2 text-xs text-muted-foreground">Courier history</p>
                        <CourierHistoryTable result={courierHistoryOf(fc.provider_response)!} />
                      </div>
                    )}
                    {Array.isArray(fc.matched_rules) && fc.matched_rules.length > 0 && (
                      <div>
                        <p className="mb-1 text-xs text-muted-foreground">Matched rules</p>
                        <ul className="space-y-1">
                          {(fc.matched_rules as Array<{ name: string; decision: keyof typeof FRAUD_DECISION; advance_amount: number }>).map((r) => (
                            <li key={r.name} className="flex justify-between gap-2"><span>{r.name}</span><span className="text-muted-foreground">{FRAUD_DECISION[r.decision]?.label}{r.advance_amount > 0 ? ` · ${formatMoney(r.advance_amount)}` : ''}</span></li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">Provider: {fc.providers?.join(', ') || fc.provider} · {fc.status}{fc.error ? ` · ${fc.error}` : ''} · {formatDateTime(fc.created_at)}</p>
                  </>
                )}
                {o.fraud_reviews.length > 0 && (
                  <div className="border-t pt-2">
                    <p className="mb-1 text-xs text-muted-foreground">Review decisions</p>
                    {o.fraud_reviews.map((r) => (
                      <p key={r.id} className="text-xs"><span className="font-medium">{titleCase(r.action)}</span> by {r.decided_by_name} · {formatDateTime(r.created_at)}{r.note ? ` — ${r.note}` : ''}</p>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </Can>
        </div>
      </div>

      {dialog === 'payment' && <RecordPaymentDialog order={o} open onOpenChange={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'refund' && <RefundDialog order={o} open onOpenChange={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'retain' && <RetainAdvanceDialog order={o} open onOpenChange={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'courier' && <AssignCourierDialog order={o} open onOpenChange={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'shipment' && <ShipmentStatusDialog order={o} open onOpenChange={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'edit' && <EditOrderDialog order={o} open onOpenChange={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'items' && <EditItemsDialog order={o} open onOpenChange={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'return' && <ReturnDialog order={o} open onOpenChange={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'partial' && <PartialDeliveryDialog order={o} open onOpenChange={() => setDialog(null)} onDone={refresh} />}
      {fraudAction && (
        <FraudDecisionDialog order={o} open action={fraudAction} onOpenChange={() => setFraudAction(null)}
          onConfirm={async (input) => {
            await fraudReviewDecide(o.id, fraudAction, input)
            toast.success('Decision recorded')
            refresh()
          }} />
      )}
      <ConfirmDialog
        open={transitionTo !== null}
        onOpenChange={(open) => !open && setTransitionTo(null)}
        title={transitionCopy(transitionTo, o.order_number, status).title}
        description={transitionCopy(transitionTo, o.order_number, status).description}
        destructive={transitionTo === 'CANCELLED' || transitionTo === 'LOST'}
        reason
        reasonRequired={transitionTo !== null && NEEDS_REASON.includes(transitionTo)}
        reasonLabel={transitionCopy(transitionTo, o.order_number, status).reason}
        confirmLabel={transitionCopy(transitionTo, o.order_number, status).confirm}
        onConfirm={(note) => transition.mutateAsync({ to: transitionTo!, note })}
      />
    </div>
  )
}

function transitionCopy(to: OrderStatus | null, number: string, from: OrderStatus) {
  switch (to) {
    case 'CANCELLED':
      return from === 'PENDING_CANCEL'
        ? { title: 'Did the courier cancel the parcel?', description: 'Reserved stock is released and the order is closed.', reason: 'Note', confirm: 'Close as cancelled' }
        : { title: `Cancel ${number}?`, description: 'Reserved stock is released and the customer is notified.', reason: 'Cancellation reason', confirm: 'Cancel order' }
    case 'PENDING_CANCEL':
      return { title: 'Ask the courier to cancel?', description: 'The order waits in Pending cancel until the courier confirms. Contact the courier now.', reason: 'Why is it being cancelled?', confirm: 'Mark pending cancel' }
    case 'LOST':
      return { title: 'Mark the parcel as lost?', description: 'The cost of the goods is booked as a loss. If it turns up, receive it or mark it delivered.', reason: 'What did the courier say?', confirm: 'Mark lost' }
    case 'FAILED_DELIVERY':
      return { title: 'Delivery failed?', description: 'The order moves to Pending return.', reason: 'What happened?', confirm: 'Mark failed' }
    default:
      return { title: `Mark ${number} as ${to ? ORDER_STATUS[to].label : ''}?`, description: undefined, reason: 'Note', confirm: 'Confirm' }
  }
}

function localInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Web orders: what happened on the call, and approval. */
function CallOutcomeCard({ order, onChanged, onApprove, approving }: { order: OrderDetail; onChanged: () => void; onApprove: () => void; approving: boolean }) {
  const { can } = useAuth()
  const statuses = useQuery({ queryKey: ['review-statuses'], queryFn: () => listReviewStatuses(), staleTime: 60_000 })
  const [code, setCode] = useState(order.review_status)
  const [note, setNote] = useState('')
  const [followUp, setFollowUp] = useState(() => localInput(new Date(Date.now() + 2 * 3600_000)))
  useEffect(() => setCode(order.review_status), [order.review_status])
  const current = statuses.data?.find((s) => s.code === order.review_status)
  const chosen = statuses.data?.find((s) => s.code === code)
  const save = useMutation({
    mutationFn: () => setWebOrderStatus([order.id], code, note, chosen?.needs_follow_up ? new Date(followUp).toISOString() : null),
    onSuccess: (r) => {
      if (r.updated) toast.success('Call status saved')
      else toast.error(r.failed[0]?.error.replace(/^[A-Z_]+: /, '') ?? 'Could not save')
      setNote('')
      onChanged()
    },
  })
  const wa = waNumber(order.customer_phone)
  const dirty = code !== order.review_status || note.trim() !== '' || (chosen?.needs_follow_up ?? false)
  const blocked = ['ADVANCE_REQUIRED', 'FRAUD_REVIEW'].includes(order.status) && !can('fraud.review')
  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3 text-sm">
            <PhoneCall className="mt-0.5 size-5 text-muted-foreground" />
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">Call the customer, then approve</p>
                <Badge variant={(current?.color ?? 'neutral') as BadgeVariant}>{current?.label ?? titleCase(order.review_status)}</Badge>
              </div>
              <p className="text-muted-foreground">
                {order.contact_attempts > 0 ? `${order.contact_attempts} call attempt${order.contact_attempts === 1 ? '' : 's'}` : 'Not called yet'}
                {order.last_contact_at && ` · last ${formatDateTime(order.last_contact_at)}`}
                {order.follow_up_at && ` · call back ${formatDateTime(order.follow_up_at)}`}
              </p>
              {order.review_note && <p className="text-muted-foreground">“{order.review_note}”</p>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" asChild><a href={`tel:${order.customer_phone}`}><Phone /> Call</a></Button>
            {wa && <Button size="sm" variant="outline" asChild><a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer"><MessageCircle /> WhatsApp</a></Button>}
            {can('orders.status') && (
              <Button size="sm" onClick={onApprove} disabled={approving || blocked} title={blocked ? 'Needs a fraud reviewer' : undefined}>
                {approving ? <Spinner /> : <Check />} Approve
              </Button>
            )}
          </div>
        </div>
        {can('orders.update') && (
          <form className="grid gap-2 border-t pt-3 sm:grid-cols-[180px_1fr_auto] sm:items-start" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
            <div className="grid gap-2">
              <Select value={code} onValueChange={setCode}>
                <SelectTrigger size="sm" aria-label="Call status"><SelectValue /></SelectTrigger>
                <SelectContent>{(statuses.data ?? []).map((st) => <SelectItem key={st.code} value={st.code}>{st.label}</SelectItem>)}</SelectContent>
              </Select>
              {chosen?.needs_follow_up && (
                <Input type="datetime-local" className="h-8" value={followUp} onChange={(e) => setFollowUp(e.target.value)} aria-label="Call back at" />
              )}
            </div>
            <Textarea rows={1} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did the customer say?" aria-label="Call note" className="min-h-8" />
            <Button size="sm" type="submit" variant={chosen?.closes_order ? 'destructive' : 'outline'} disabled={!dirty || save.isPending}>
              {save.isPending && <Spinner />} {chosen?.closes_order ? `Close as ${chosen.label}` : 'Save'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

function NotesCard({ orderId, notes, onAdded, canAdd, phone }: {
  orderId: string
  notes: OrderDetail['order_notes']
  onAdded: () => void
  canAdd: boolean
  phone: string
}) {
  const [body, setBody] = useState('')
  const [kind, setKind] = useState<'INTERNAL' | 'CUSTOMER' | 'CONTACT'>('INTERNAL')
  const add = useMutation({
    mutationFn: () => addOrderNote(orderId, body, kind === 'CUSTOMER' ? 'CUSTOMER' : 'INTERNAL', kind === 'CONTACT' ? 'CONTACT' : 'NOTE'),
    onSuccess: () => { setBody(''); onAdded() },
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Notes</CardTitle>
        <CardAction><Button size="sm" variant="ghost" asChild><a href={`tel:${phone}`}><Phone /> Call customer</a></Button></CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {canAdd && (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate() }}>
            <Textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder={kind === 'CONTACT' ? 'What did the customer say?' : 'Add a note…'} aria-label="Note" />
            <div className="flex items-center justify-between gap-2">
              <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
                <SelectTrigger size="sm" className="w-48"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="INTERNAL">Internal note</SelectItem>
                  <SelectItem value="CUSTOMER">Customer-facing note</SelectItem>
                  <SelectItem value="CONTACT">Log customer contact</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" type="submit" disabled={!body.trim() || add.isPending}>{add.isPending && <Spinner />} Add</Button>
            </div>
          </form>
        )}
        {notes.length === 0 ? <p className="text-sm text-muted-foreground">No notes yet.</p> : (
          <ul className="space-y-2">
            {notes.map((n) => (
              <li key={n.id} className={cn('rounded-md p-2.5 text-sm', n.visibility === 'CUSTOMER' ? 'bg-sky-50' : 'bg-muted/60')}>
                <p className="whitespace-pre-line">{n.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {n.kind === 'CONTACT' ? 'Contact log' : n.visibility === 'CUSTOMER' ? 'Customer note' : 'Internal'} · {n.created_by_name ?? 'Staff'} · {formatDateTime(n.created_at)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

/** What the courier charged for this parcel: latest figure per fee, and where it came from. */
function CourierCharges({ charges }: { charges: OrderDetail['shipments'][number]['shipment_charges'] }) {
  const [open, setOpen] = useState(false)
  if (!charges.length) return null
  const sorted = [...charges].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const latest = new Map<string, (typeof sorted)[number]>()
  for (const c of sorted) latest.set(c.kind, c)
  const total = [...latest.values()].reduce((s, c) => s + toNumber(c.total_after), 0)
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">Courier charges</p>
        <button type="button" className="text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide history' : `History (${charges.length})`}
        </button>
      </div>
      <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
        {[...latest.values()].map((c) => (
          <div key={c.kind}>
            <dt className="text-xs text-muted-foreground">{CHARGE_KIND[c.kind]}</dt>
            <dd><Money value={c.total_after} /> <span className="text-xs text-muted-foreground">· {CHARGE_SOURCE[c.source]}</span></dd>
          </div>
        ))}
        <div><dt className="text-xs text-muted-foreground">Total</dt><dd className="font-medium"><Money value={total} /></dd></div>
      </dl>
      {open && (
        <ul className="mt-2 space-y-0.5 border-t pt-2 text-xs">
          {sorted.map((c) => (
            <li key={c.id} className="flex justify-between gap-3">
              <span>{c.note ?? CHARGE_KIND[c.kind]} <span className="text-muted-foreground">· {formatDateTime(c.created_at)}</span></span>
              <Money value={c.amount} className={cn(toNumber(c.amount) < 0 && 'text-emerald-700')} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
