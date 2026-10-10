import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCcw, Save } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { getIn, type Path, setIn } from '@/lib/object'
import { getSettings, updateSetting } from '@/services/settings'

/** Editable draft of one settings row, saved through admin_update_setting (validated server-side). */
export function useSettingDraft(key: string) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const server = query.data?.[key]
  const [draft, setDraft] = useState<Record<string, unknown> | undefined>()
  useEffect(() => {
    if (server) setDraft(structuredClone(server))
  }, [server])
  const dirty = !!draft && !!server && JSON.stringify(draft) !== JSON.stringify(server)
  const save = useMutation({
    mutationFn: () => updateSetting(key, draft!),
    onSuccess: () => {
      toast.success('Settings saved')
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
      void queryClient.invalidateQueries({ queryKey: ['store-config'] })
    },
  })
  return {
    query,
    draft,
    dirty,
    save,
    canEdit: can('settings.manage'),
    get: (path: Path) => getIn(draft, path),
    set: (path: Path, value: unknown) => setDraft((d) => setIn(d, path, value)),
    reset: () => server && setDraft(structuredClone(server)),
  }
}
export type SettingDraft = ReturnType<typeof useSettingDraft>

/** Card wrapping one settings row with Save / Discard. */
export function SettingCard({ setting, title, description, children, validate }: {
  setting: SettingDraft
  title: string
  description?: ReactNode
  children: ReactNode
  /** Returns an error message to block saving. */
  validate?: () => string | null
}) {
  const { query, draft, dirty, save, canEdit, reset } = setting
  const error = dirty && validate ? validate() : null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        {query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : !draft ? <LoadingState /> : (
          <fieldset disabled={!canEdit || save.isPending} className="grid gap-4">{children}</fieldset>
        )}
      </CardContent>
      {canEdit && draft && (
        <CardFooter className="flex flex-wrap items-center justify-end gap-2 border-t">
          {error && <p className="mr-auto text-sm text-destructive" role="alert">{error}</p>}
          {dirty && <Button variant="ghost" size="sm" onClick={reset} disabled={save.isPending}><RotateCcw /> Discard</Button>}
          <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || !!error || save.isPending}>
            {save.isPending ? <Spinner /> : <Save />} Save
          </Button>
        </CardFooter>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Bound inputs: read and write one path of a setting draft.
// ---------------------------------------------------------------------------
interface BoundProps {
  s: SettingDraft
  path: Path
  label: ReactNode
  hint?: ReactNode
  className?: string
}

const fieldId = (path: Path) => `set-${path.join('-')}`

export function TextSetting({ s, path, label, hint, className, placeholder, nullable, mono }: BoundProps & { placeholder?: string; nullable?: boolean; mono?: boolean }) {
  const value = s.get(path)
  return (
    <Field label={label} hint={hint} htmlFor={fieldId(path)} className={className}>
      <Input id={fieldId(path)} className={mono ? 'font-mono' : undefined} placeholder={placeholder} value={(value as string | null) ?? ''}
        onChange={(e) => s.set(path, nullable && e.target.value === '' ? null : e.target.value)} />
    </Field>
  )
}

export function TextareaSetting({ s, path, label, hint, className, rows = 3 }: BoundProps & { rows?: number }) {
  return (
    <Field label={label} hint={hint} htmlFor={fieldId(path)} className={className}>
      <Textarea id={fieldId(path)} rows={rows} value={(s.get(path) as string | null) ?? ''} onChange={(e) => s.set(path, e.target.value)} />
    </Field>
  )
}

export function NumberSetting({ s, path, label, hint, className, min, max, step = 1, nullable }: BoundProps & { min?: number; max?: number; step?: number; nullable?: boolean }) {
  const value = s.get(path)
  return (
    <Field label={label} hint={hint} htmlFor={fieldId(path)} className={className}>
      <Input id={fieldId(path)} type="number" min={min} max={max} step={step} value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => s.set(path, e.target.value === '' ? (nullable ? null : 0) : Number(e.target.value))} />
    </Field>
  )
}

export function SwitchSetting({ s, path, label, hint }: Omit<BoundProps, 'className'>) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <Switch checked={Boolean(s.get(path))} onCheckedChange={(v) => s.set(path, v)} className="mt-0.5" />
      <span>{label}{hint && <span className="block text-xs text-muted-foreground">{hint}</span>}</span>
    </label>
  )
}

export function SelectSetting({ s, path, label, hint, className, options }: BoundProps & { options: Array<{ value: string; label: string }> }) {
  return (
    <Field label={label} hint={hint} className={className}>
      <Select value={String(s.get(path) ?? '')} onValueChange={(v) => s.set(path, v)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
      </Select>
    </Field>
  )
}

/** A string[] edited as text: one per line, or comma separated. */
export function ListSetting({ s, path, label, hint, className, separator = 'line', rows = 4, mono }: BoundProps & { separator?: 'line' | 'comma'; rows?: number; mono?: boolean }) {
  const list = (s.get(path) as string[] | undefined) ?? []
  const joined = list.join(separator === 'line' ? '\n' : ', ')
  const [text, setText] = useState(joined)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(joined)
  }, [joined, focused])
  // The parsed list is saved on every keystroke; the raw text is kept while typing
  // so a trailing comma or newline isn't swallowed.
  const change = (value: string) => {
    setText(value)
    s.set(path, value.split(separator === 'line' ? /\n/ : /[,\n]/).map((x) => x.trim()).filter(Boolean))
  }
  const props = { id: fieldId(path), value: text, onFocus: () => setFocused(true), onBlur: () => setFocused(false), onChange: (e: { target: { value: string } }) => change(e.target.value) }
  return (
    <Field label={label} hint={hint} htmlFor={fieldId(path)} className={className}>
      {separator === 'line'
        ? <Textarea rows={rows} className={mono ? 'font-mono' : undefined} {...props} />
        : <Input className={mono ? 'font-mono' : undefined} {...props} />}
    </Field>
  )
}
