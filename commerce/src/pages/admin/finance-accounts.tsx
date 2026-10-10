import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDownUp, Landmark, Pencil, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { EmptyState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/features/auth/auth-context'
import { isoDate } from '@/lib/dates'
import { formatDate, formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  type FinanceAccount, type FinanceAccountKind, financeAccounts, financeMovements, moveFinanceAccount, saveFinanceAccount,
} from '@/services/marketing'

const KIND: Record<FinanceAccountKind, string> = { CASH: 'Cash', BANK: 'Bank account', MOBILE_WALLET: 'bKash / Nagad', CARD: 'Card', OTHER: 'Other' }
const PAGE_SIZE = 25

/** Where the money sits: balances, top-ups, and what Meta Ads withdrew. */
export default function FinanceAccountsPage() {
  const { can } = useAuth()
  const manage = can('finance.manage')
  const queryClient = useQueryClient()
  const list = useQuery({ queryKey: ['finance', 'accounts'], queryFn: financeAccounts })
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<FinanceAccount | 'new' | null>(null)
  const [moving, setMoving] = useState<FinanceAccount | null>(null)
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['finance'] })
  const accounts = list.data ?? []
  const current = accounts.find((a) => a.id === selected) ?? accounts[0]

  return (
    <div className="space-y-4">
      <PageHeader title="Payment Accounts"
        description="Cash, bank, bKash and cards the business pays from. Meta Ads accounts linked to one have each day's spend withdrawn the day after."
        actions={manage && <Button size="sm" onClick={() => setEditing('new')}><Plus /> Add account</Button>} />
      {list.isLoading ? <LoadingState /> : accounts.length === 0 ? (
        <Card><CardContent>
          <EmptyState icon={<Landmark className="size-5" />} title="No payment accounts yet"
            description="Add the card or bank account your ads are paid from, then choose it on the Meta Ads account."
            action={manage ? <Button size="sm" onClick={() => setEditing('new')}><Plus /> Add account</Button> : undefined} />
        </CardContent></Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <ul className="grid content-start gap-2">
            {accounts.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => setSelected(a.id)}
                  className={cn('flex w-full items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left hover:bg-muted/50', current?.id === a.id && 'border-ring')}>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">{a.name}{!a.is_active && <Badge variant="neutral">inactive</Badge>}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {KIND[a.kind]}{a.meta_accounts.length ? ` · pays ${a.meta_accounts.map((m) => m.name).join(', ')}` : ''}
                    </p>
                  </div>
                  <Money value={a.balance ?? 0} className={cn('font-semibold tabular-nums', Number(a.balance) < 0 && 'text-red-600')} />
                </button>
              </li>
            ))}
          </ul>
          {current && <Movements account={current} manage={manage} onEdit={() => setEditing(current)} onMove={() => setMoving(current)} />}
        </div>
      )}
      {editing && <AccountDialog account={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {moving && <MoveDialog account={moving} onClose={() => setMoving(null)} onSaved={refresh} />}
    </div>
  )
}

function Movements({ account, manage, onEdit, onMove }: { account: FinanceAccount; manage: boolean; onEdit: () => void; onMove: () => void }) {
  const [page, setPage] = useState(1)
  const moves = useQuery({
    queryKey: ['finance', 'movements', account.id, page],
    placeholderData: keepPreviousData,
    queryFn: () => financeMovements(account.id, page, PAGE_SIZE),
  })
  const items = moves.data?.items ?? []
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">{account.name}</CardTitle>
        <CardDescription>
          Opening balance <Money value={account.opening_balance ?? 0} /> · now <Money value={account.balance ?? 0} />
          {account.notes ? ` · ${account.notes}` : ''}
        </CardDescription>
        {manage && (
          <CardAction className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onMove}><ArrowDownUp /> Money in / out</Button>
            <Button size="sm" variant="ghost" onClick={onEdit} aria-label="Edit account"><Pencil /></Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        {moves.isLoading ? <LoadingState /> : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No money has moved in or out yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {items.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="break-words">{m.description}</p>
                  <p className="text-xs text-muted-foreground" title={formatDateTime(m.created_at)}>
                    {formatDate(m.movement_date)} · {m.source === 'META_ADS' ? 'Meta Ads sync' : m.created_by_name ?? 'staff'}
                  </p>
                </div>
                <Money value={m.amount} className={cn('shrink-0 font-medium tabular-nums', m.amount < 0 ? 'text-red-600' : 'text-emerald-600')} />
              </li>
            ))}
          </ul>
        )}
        <Pagination page={page} pageSize={PAGE_SIZE} total={moves.data?.total ?? 0} onPage={setPage} />
      </CardContent>
    </Card>
  )
}

function AccountDialog({ account, onClose, onSaved }: { account: FinanceAccount | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(account?.name ?? '')
  const [kind, setKind] = useState<FinanceAccountKind>(account?.kind ?? 'CARD')
  const [opening, setOpening] = useState(String(account?.opening_balance ?? 0))
  const [active, setActive] = useState(account?.is_active ?? true)
  const [notes, setNotes] = useState(account?.notes ?? '')
  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => saveFinanceAccount({ id: account?.id, name: name.trim(), kind, opening_balance: Number(opening) || 0, is_active: active, notes }),
    onSuccess: () => { toast.success('Saved'); onSaved(); onClose() },
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={account ? `Edit ${account.name}` : 'Add payment account'}
      submitLabel={account ? 'Save' : 'Create'} onSubmit={() => save.mutate()} busy={save.isPending} disabled={name.trim().length < 2}>
      <Field label="Name" htmlFor="fa-name" required><Input id="fa-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. City Bank Visa" maxLength={80} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type" htmlFor="fa-kind">
          <Select value={kind} onValueChange={(v) => setKind(v as FinanceAccountKind)}>
            <SelectTrigger id="fa-kind" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(KIND).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Opening balance" htmlFor="fa-opening" hint="What was in it when you started tracking.">
          <Input id="fa-opening" type="number" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} />
        </Field>
      </div>
      <Field label="Notes" htmlFor="fa-notes"><Input id="fa-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Last 4 digits, branch…" maxLength={500} /></Field>
      <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
        <span className="text-sm font-medium">Active</span>
        <Switch checked={active} onCheckedChange={setActive} />
      </label>
      {save.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{(save.error as Error).message.replace(/^[A-Z_]+: /, '')}</p>}
    </FormDialog>
  )
}

function MoveDialog({ account, onClose, onSaved }: { account: FinanceAccount; onClose: () => void; onSaved: () => void }) {
  const [direction, setDirection] = useState<'in' | 'out'>('in')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(() => isoDate(new Date()))
  const [description, setDescription] = useState('')
  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => moveFinanceAccount(account.id, (direction === 'in' ? 1 : -1) * Number(amount), date, description.trim()),
    onSuccess: () => { toast.success('Recorded'); onSaved(); onClose() },
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={`Money in or out · ${account.name}`}
      description="For top-ups, transfers and bank fees. Entries are permanent; record a correcting entry for a mistake."
      submitLabel="Record" onSubmit={() => save.mutate()} busy={save.isPending} disabled={!(Number(amount) > 0) || description.trim().length < 2}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Direction" htmlFor="fm-dir">
          <Select value={direction} onValueChange={(v) => setDirection(v as 'in' | 'out')}>
            <SelectTrigger id="fm-dir" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="in">Money in</SelectItem><SelectItem value="out">Money out</SelectItem></SelectContent>
          </Select>
        </Field>
        <Field label="Amount" htmlFor="fm-amount" required><Input id="fm-amount" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Date" htmlFor="fm-date"><Input id="fm-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <Field label="What for" htmlFor="fm-desc" required><Input id="fm-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Card top-up from bKash" maxLength={300} /></Field>
      {save.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{(save.error as Error).message.replace(/^[A-Z_]+: /, '')}</p>}
    </FormDialog>
  )
}
