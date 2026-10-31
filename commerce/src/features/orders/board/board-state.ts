import type { BadgeVariant } from '@/components/ui/badge'
import { ORDER_STAGES, type OrderStage } from '@/lib/status'
import type { BoardFilters, CourierPayment, OrdersBoardOptions } from '@/services/order-tools'

// The Orders Dashboard's filter panel keeps its values in the page address, so a reload, the
// back button or a shared link shows the same list. Every value is a string; lists are
// comma-separated.

export const BOARD_KEYS = [
  'by', 'from', 'to', 'tfrom', 'tto', 'product', 'source', 'courier', 'taken', 'pay', 'invoice', 'status', 'tags', 'district',
] as const
export type BoardKey = (typeof BOARD_KEYS)[number]
export type BoardValues = Record<BoardKey, string>

export type DateBy = NonNullable<BoardFilters['date_by']>
export const DATE_BY: Array<{ value: DateBy; label: string; time: string }> = [
  { value: 'approved', label: 'By approved date', time: 'Approved time range' },
  { value: 'order', label: 'By order date', time: 'Order time range' },
  { value: 'shipped', label: 'By shipped date', time: 'Shipped time range' },
  { value: 'delivered', label: 'By delivered date', time: 'Delivered time range' },
]

export const COURIER_PAYMENT: Record<CourierPayment, string> = {
  paid: 'Paid by courier',
  unpaid: 'Not paid yet',
  none: 'Nothing due',
}

export const EMPTY_BOARD: BoardValues = {
  by: 'approved', from: '', to: '', tfrom: '', tto: '', product: '', source: '', courier: '', taken: '', pay: '', invoice: '',
  status: '', tags: '', district: '',
}

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)
const isMinute = (v: string) => /^\d{1,4}$/.test(v) && Number(v) <= 1439

/** Reads the panel's values from the address, dropping anything malformed. */
export function boardValues(params: URLSearchParams): BoardValues {
  const v = { ...EMPTY_BOARD }
  for (const key of BOARD_KEYS) v[key] = (params.get(key) ?? '').trim()
  if (!DATE_BY.some((d) => d.value === v.by)) v.by = 'approved'
  if (v.from && !isDate(v.from)) v.from = ''
  if (v.to && !isDate(v.to)) v.to = ''
  if (v.tfrom && !isMinute(v.tfrom)) v.tfrom = ''
  if (v.tto && !isMinute(v.tto)) v.tto = ''
  if (v.pay && !(v.pay in COURIER_PAYMENT)) v.pay = ''
  return v
}

/** The address for new values: other parameters (the page size, the tab) are kept, the page goes back to 1. */
export function boardParams(values: BoardValues, base: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(base)
  for (const key of BOARD_KEYS) {
    const value = values[key]
    if (!value || (key === 'by' && value === EMPTY_BOARD.by)) next.delete(key)
    else next.set(key, value)
  }
  next.delete('page')
  return next
}

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean)

/** What the server is asked for. */
export function boardFilters(v: BoardValues): BoardFilters {
  return {
    date_by: v.by as DateBy,
    date_from: v.from || undefined,
    date_to: v.to || undefined,
    time_from: v.tfrom === '' ? undefined : Number(v.tfrom),
    time_to: v.tto === '' ? undefined : Number(v.tto),
    product: v.product || undefined,
    source: v.source || undefined,
    courier_id: v.courier || undefined,
    taken_by: v.taken || undefined,
    courier_payment: (v.pay || undefined) as CourierPayment | undefined,
    invoice: v.invoice || undefined,
    statuses: list(v.status),
    tags: list(v.tags),
    district: v.district || undefined,
  }
}

/** How many filters are set (a date range or a time range counts once; "filter by" alone does not). */
export function activeFilters(v: BoardValues): number {
  const single: BoardKey[] = ['product', 'source', 'courier', 'taken', 'pay', 'invoice', 'status', 'tags', 'district']
  return single.filter((k) => v[k]).length + (v.from || v.to ? 1 : 0) + (v.tfrom || v.tto ? 1 : 0)
}

export const splitList = list

// --------------------------------------------------------------------------- times

/** Every half hour of the day, as minutes after midnight. */
export const HALF_HOURS = Array.from({ length: 48 }, (_, i) => i * 30)
/** The last minute of the day, for "To" choices that end a range at midnight. */
export const END_OF_DAY = 1439

/** 0 → "12:00 am", 810 → "1:30 pm", 1439 → "11:59 pm". */
export function timeLabel(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

// --------------------------------------------------------------------------- statuses

export interface StatusInfo {
  key: string
  label: string
  /** "approved" for an approved order's stage, "web" for a web order's call status. */
  group: 'approved' | 'web'
  variant: BadgeVariant
  hint?: string
}

const STAGE_INFO = new Map(ORDER_STAGES.map((s) => [s.key, s]))
/** NO_RESPONSE → "No response". */
const sentence = (code: string) => code.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

/** A status key from the server (PENDING, DELIVERED, WEB:NO_RESPONSE, …) as people read it. */
export function statusInfo(key: string, callStatuses: OrdersBoardOptions['call_statuses'] = []): StatusInfo {
  if (key.startsWith('WEB:')) {
    const code = key.slice(4)
    const call = callStatuses.find((c) => c.code === code)
    return { key, group: 'web', label: call?.label ?? sentence(code), variant: (call?.color ?? 'neutral') as BadgeVariant }
  }
  const stage = STAGE_INFO.get(key as OrderStage)
  return stage
    ? { key, group: 'approved', label: stage.label, variant: stage.variant, hint: stage.hint }
    : { key, group: 'approved', label: sentence(key), variant: 'neutral' }
}

/** Every status the panel offers: approved stages in their usual order, then the web call statuses. */
export function statusChoices(callStatuses: OrdersBoardOptions['call_statuses'] = []): StatusInfo[] {
  return [
    ...ORDER_STAGES.map((s) => statusInfo(s.key)),
    ...callStatuses.map((c) => statusInfo(`WEB:${c.code}`, callStatuses)),
  ]
}
