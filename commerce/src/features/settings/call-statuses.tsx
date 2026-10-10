import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Spinner } from '@/components/common/states'
import { Badge, type BadgeVariant } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/features/auth/auth-context'
import { listReviewStatuses, saveReviewStatus } from '@/services/orders'
import type { ReviewStatus } from '@/types/domain'

const COLORS: Array<{ value: BadgeVariant; label: string }> = [
  { value: 'neutral', label: 'Grey' }, { value: 'info', label: 'Blue' }, { value: 'violet', label: 'Violet' },
  { value: 'success', label: 'Green' }, { value: 'warning', label: 'Amber' }, { value: 'danger', label: 'Red' },
]

/** The call outcomes staff pick for web orders (Settings → Orders). */
export function CallStatusesSettings() {
  const { can } = useAuth()
  const statuses = useQuery({ queryKey: ['review-statuses', 'all'], queryFn: () => listReviewStatuses(true) })
  const [editing, setEditing] = useState<ReviewStatus | 'new' | null>(null)
  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <CardTitle>Web order call statuses</CardTitle>
        <CardDescription>What staff record after calling a customer. Statuses that close an order cancel it and return its stock.</CardDescription>
        {can('settings.manage') && <CardAction><Button size="sm" variant="outline" onClick={() => setEditing('new')}><Plus /> Add status</Button></CardAction>}
      </CardHeader>
      <CardContent>
        {statuses.isLoading ? <Spinner /> : (
          <ul className="divide-y rounded-md border text-sm">
            {(statuses.data ?? []).map((s) => (
              <li key={s.code} className="flex flex-wrap items-center gap-3 p-2.5">
                <Badge variant={s.color as BadgeVariant} className={s.is_active ? undefined : 'opacity-50'}>{s.label}</Badge>
                <span className="min-w-40 flex-1 text-muted-foreground">{s.description}</span>
                <span className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                  {s.closes_order && <Badge variant="outline">Closes order</Badge>}
                  {s.needs_follow_up && <Badge variant="outline">Call-back time</Badge>}
                  {s.counts_contact && <Badge variant="outline">Counts a call</Badge>}
                  {!s.is_active && <Badge variant="outline">Off</Badge>}
                  {s.is_system && <span className="self-center">Built-in</span>}
                </span>
                {can('settings.manage') && <Button size="icon-sm" variant="ghost" aria-label={`Edit ${s.label}`} onClick={() => setEditing(s)}><Pencil /></Button>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {editing && <EditCallStatus status={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  )
}

function EditCallStatus({ status, onClose }: { status: ReviewStatus | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState({
    label: '', description: '', color: 'neutral', sort_order: 60, closes_order: false, needs_follow_up: false, counts_contact: false, is_active: true,
  })
  useEffect(() => {
    if (status) {
      setDraft({
        label: status.label, description: status.description ?? '', color: status.color, sort_order: status.sort_order,
        closes_order: status.closes_order, needs_follow_up: status.needs_follow_up, counts_contact: status.counts_contact, is_active: status.is_active,
      })
    }
  }, [status])
  const builtIn = status?.is_system ?? false
  const save = useMutation({
    mutationFn: () => saveReviewStatus({ ...draft, code: status?.code }),
    onSuccess: () => {
      toast.success('Status saved')
      void queryClient.invalidateQueries({ queryKey: ['review-statuses'] })
      onClose()
    },
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={status ? `Edit ${status.label}` : 'Add a call status'} submitLabel="Save"
      busy={save.isPending} disabled={!draft.label.trim()} onSubmit={() => save.mutate()}
      description={builtIn ? 'Built-in statuses keep how they behave; you can rename, recolour or hide them.' : undefined}>
      <Field label="Name" htmlFor="cs-label"><Input id="cs-label" maxLength={40} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="e.g. Wrong number" /></Field>
      <Field label="Description" htmlFor="cs-desc"><Input id="cs-desc" maxLength={200} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Colour" htmlFor="cs-color">
          <Select value={draft.color} onValueChange={(v) => setDraft({ ...draft, color: v })}>
            <SelectTrigger id="cs-color"><SelectValue /></SelectTrigger>
            <SelectContent>{COLORS.map((c) => <SelectItem key={c.value} value={c.value}><Badge variant={c.value}>{c.label}</Badge></SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Position" htmlFor="cs-order"><Input id="cs-order" type="number" min={0} value={draft.sort_order} onChange={(e) => setDraft({ ...draft, sort_order: Number(e.target.value) })} /></Field>
      </div>
      <div className="grid gap-2.5 text-sm">
        {[
          { key: 'closes_order' as const, label: 'Closes the order (cancels it and returns stock)' },
          { key: 'needs_follow_up' as const, label: 'Asks for a call-back time' },
          { key: 'counts_contact' as const, label: 'Counts as a call attempt' },
        ].map((f) => (
          <label key={f.key} className="flex items-center gap-2">
            <Switch checked={draft[f.key]} disabled={builtIn} onCheckedChange={(v) => setDraft({ ...draft, [f.key]: v })} /> {f.label}
          </label>
        ))}
        <label className="flex items-center gap-2">
          <Switch checked={draft.is_active} onCheckedChange={(v) => setDraft({ ...draft, is_active: v })} /> Shown to staff
        </label>
      </div>
    </FormDialog>
  )
}
