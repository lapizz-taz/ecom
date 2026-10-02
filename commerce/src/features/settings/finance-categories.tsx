import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/features/auth/auth-context'
import { type FinanceCategory, listCategories, saveCategory } from '@/services/finance'
import type { Enums } from '@/types/database'

const GROUP_LABEL: Record<Enums<'pnl_group'>, string> = {
  REVENUE: 'Revenue', DELIVERY_INCOME: 'Delivery income', OTHER_INCOME: 'Other income', CONTRA_REVENUE: 'Refunds (reduce revenue)',
  COGS: 'Cost of sales', OPERATING_EXPENSE: 'Operating expense', NONE: 'Cash only (not in P&L)',
}
// Groups a hand-made category may use; revenue lines are only posted by the system.
const GROUPS_FOR: Record<Enums<'finance_type'>, Array<Enums<'pnl_group'>>> = {
  INCOME: ['OTHER_INCOME', 'NONE'],
  EXPENSE: ['OPERATING_EXPENSE', 'COGS', 'NONE'],
}

export function FinanceCategories() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const categories = useQuery({ queryKey: ['finance-categories', 'all'], queryFn: () => listCategories() })
  const [editing, setEditing] = useState<Partial<FinanceCategory> | null>(null)
  const canEdit = can('finance.manage')
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Income & expense categories</CardTitle>
        <CardDescription>System categories drive automatic postings and can only be renamed. Categories can be deactivated but never deleted, so history stays intact.</CardDescription>
        {canEdit && <CardAction><Button size="sm" onClick={() => setEditing({ type: 'EXPENSE', pnl_group: 'OPERATING_EXPENSE', is_active: true })}><Plus /> Add category</Button></CardAction>}
      </CardHeader>
      <CardContent>
        {categories.isLoading ? <LoadingState /> : (
          <div className="grid gap-6 md:grid-cols-2">
            {(['INCOME', 'EXPENSE'] as const).map((type) => (
              <div key={type}>
                <p className="mb-2 text-sm font-medium">{type === 'INCOME' ? 'Income' : 'Expenses'}</p>
                <ul className="divide-y rounded-lg border">
                  {(categories.data ?? []).filter((c) => c.type === type).map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <p className={c.is_active ? '' : 'text-muted-foreground line-through'}>
                          {c.name} {c.is_system && <Badge variant="neutral">system</Badge>} {!c.allow_manual && <Badge variant="info">automatic</Badge>}
                        </p>
                        <p className="text-xs text-muted-foreground">{GROUP_LABEL[c.pnl_group]}</p>
                      </div>
                      {canEdit && <Button size="icon-sm" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Pencil /></Button>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <CategoryDialog value={editing} onClose={() => setEditing(null)} onSaved={() => void queryClient.invalidateQueries({ queryKey: ['finance-categories'] })} />
    </Card>
  )
}

function CategoryDialog({ value, onClose, onSaved }: { value: Partial<FinanceCategory> | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState<Enums<'finance_type'>>('EXPENSE')
  const [group, setGroup] = useState<Enums<'pnl_group'>>('OPERATING_EXPENSE')
  const [active, setActive] = useState(true)
  const [description, setDescription] = useState('')
  useEffect(() => {
    if (!value) return
    setName(value.name ?? '')
    setType(value.type ?? 'EXPENSE')
    setGroup(value.pnl_group ?? 'OPERATING_EXPENSE')
    setActive(value.is_active ?? true)
    setDescription(value.description ?? '')
  }, [value])
  const isNew = !value?.id
  const code = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'C_$1')
  const save = useMutation({
    mutationFn: () => saveCategory({
      id: value?.id, name: name.trim(), code, type, pnl_group: group, is_active: active, description: description.trim() || null,
    }),
    onSuccess: () => { toast.success('Category saved'); onClose(); onSaved() },
  })
  return (
    <FormDialog open={value !== null} onOpenChange={(o) => !o && onClose()} title={isNew ? 'New category' : `Edit ${value?.name}`} submitLabel="Save"
      busy={save.isPending} disabled={!name.trim() || !code} onSubmit={() => save.mutate()}>
      <Field label="Name" htmlFor="fc-name" required hint={isNew && code ? `Code: ${code}` : undefined}><Input id="fc-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      {isNew && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">
            <Select value={type} onValueChange={(v) => { setType(v as Enums<'finance_type'>); setGroup(GROUPS_FOR[v as Enums<'finance_type'>][0]) }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="INCOME">Income</SelectItem><SelectItem value="EXPENSE">Expense</SelectItem></SelectContent>
            </Select>
          </Field>
          <Field label="Profit & loss line">
            <Select value={group} onValueChange={(v) => setGroup(v as Enums<'pnl_group'>)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{GROUPS_FOR[type].map((g) => <SelectItem key={g} value={g}>{GROUP_LABEL[g]}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </div>
      )}
      <Field label="Description" htmlFor="fc-desc"><Input id="fc-desc" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      {!value?.is_system && <label className="flex items-center gap-2 text-sm"><Switch checked={active} onCheckedChange={setActive} /> Active</label>}
    </FormDialog>
  )
}
