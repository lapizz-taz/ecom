import { useQuery } from '@tanstack/react-query'
import { ImagePlus, Plus, Trash2, X } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { Spinner } from '@/components/common/states'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import type { FieldDef, Settings } from '@/features/storefront/theme'
import { toUserMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { imageUrl, uploadThemeImage } from '@/services/catalog'
import { getCategories } from '@/services/storefront'

export const inputClass = 'h-8 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-[13px] outline-none transition-shadow focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-200'

export function FieldRow({ label, hint, children, inline }: { label: string; hint?: string; children: ReactNode; inline?: boolean }) {
  return (
    <div className={cn('grid gap-1.5', inline && 'flex items-center justify-between gap-3')}>
      <span className="text-[13px] text-zinc-700 dark:text-zinc-300">{label}</span>
      {children}
      {hint && !inline && <span className="text-[11px] leading-snug text-zinc-500">{hint}</span>}
    </div>
  )
}

const LINKS = ['/', '/shop', '/shop?sort=newest', '/track-order', '/contact', '/policies/shipping', '/policies/returns', '/policies/privacy', '/policies/terms']

function LinkInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const categories = useQuery({ queryKey: ['storefront-categories'], queryFn: getCategories, staleTime: 10 * 60_000 })
  const id = useRef(`links-${Math.random().toString(36).slice(2)}`).current
  return (
    <>
      <input className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? '/shop or https://…'} list={id} />
      <datalist id={id}>
        {LINKS.map((l) => <option key={l} value={l} />)}
        {(categories.data ?? []).map((c) => <option key={c.id} value={`/collection/${c.slug}`}>{c.name}</option>)}
      </datalist>
    </>
  )
}

function ImageInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const file = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const upload = async (f: File) => {
    setBusy(true)
    try { onChange(await uploadThemeImage(f)) } catch (e) { toast.error(toUserMessage(e)) } finally { setBusy(false) }
  }
  return (
    <div className="grid gap-2">
      <div className="relative grid aspect-[16/9] place-items-center overflow-hidden rounded-lg border border-dashed border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900">
        {value ? <img src={imageUrl(value, 600)} alt="" className="absolute inset-0 size-full object-cover" /> : null}
        <button type="button" onClick={() => file.current?.click()} disabled={busy}
          className={cn('relative z-10 inline-flex items-center gap-1.5 rounded-lg border bg-white px-2.5 py-1.5 text-xs font-medium shadow-xs hover:bg-zinc-50 dark:bg-zinc-800', value && 'opacity-0 hover:opacity-100 focus:opacity-100')}>
          {busy ? <Spinner className="size-3.5" /> : <ImagePlus className="size-3.5" />} {value ? 'Change' : 'Select image'}
        </button>
        {value && (
          <button type="button" aria-label="Remove image" onClick={() => onChange('')} className="absolute top-1.5 right-1.5 z-10 grid size-6 place-items-center rounded-md bg-white/90 shadow-xs hover:bg-white">
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = '' }} />
      <input className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} placeholder="or paste an image link (https://…)" />
    </div>
  )
}

export function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex h-8 items-center gap-2 rounded-lg border border-zinc-300 bg-white px-1.5 dark:border-zinc-700 dark:bg-zinc-900">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="size-5 cursor-pointer rounded border-0 bg-transparent p-0" />
      <input className="w-full bg-transparent font-mono text-xs outline-none" value={value} onChange={(e) => /^#[0-9a-f]{0,6}$/i.test(e.target.value) && onChange(e.target.value)} />
    </label>
  )
}

export function SelectInput({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <select className={cn(inputClass, 'appearance-none bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 20 20%27 fill=%27%2371717a%27%3E%3Cpath d=%27M6 8l4 4 4-4%27/%3E%3C/svg%3E")] bg-[length:16px] bg-[right_6px_center] bg-no-repeat pr-7')}
      value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

export function RangeInput({ value, onChange, min, max, step = 1, unit }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number; unit?: string }) {
  return (
    <div className="flex items-center gap-3">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-1 flex-1 cursor-pointer accent-zinc-900 dark:accent-zinc-100" />
      <span className="w-12 rounded-md border border-zinc-300 px-1.5 py-0.5 text-right text-xs tabular-nums dark:border-zinc-700">{value}{unit}</span>
    </div>
  )
}

/** The editor for one schema field of a section. */
export function SchemaField({ field, settings, onChange }: { field: FieldDef; settings: Settings; onChange: (key: string, v: unknown) => void }) {
  const v = settings[field.key]
  const set = (x: unknown) => onChange(field.key, x)
  const str = typeof v === 'string' ? v : ''
  switch (field.type) {
    case 'text':
    case 'video':
      return <FieldRow label={field.label} hint={field.hint}><input className={inputClass} value={str} onChange={(e) => set(e.target.value)} placeholder={'placeholder' in field ? field.placeholder : undefined} /></FieldRow>
    case 'textarea':
      return <FieldRow label={field.label} hint={field.hint}><textarea rows={3} className={cn(inputClass, 'h-auto py-1.5')} value={str} onChange={(e) => set(e.target.value)} /></FieldRow>
    case 'link':
      return <FieldRow label={field.label} hint={field.hint}><LinkInput value={str} onChange={set} /></FieldRow>
    case 'image':
      return <FieldRow label={field.label} hint={field.hint}><ImageInput value={str} onChange={set} /></FieldRow>
    case 'color':
      return <FieldRow label={field.label}><ColorInput value={str || '#000000'} onChange={set} /></FieldRow>
    case 'select':
      return <FieldRow label={field.label} hint={field.hint}><SelectInput value={String(v ?? field.options[0]?.value)} onChange={set} options={field.options} /></FieldRow>
    case 'toggle':
      return <FieldRow label={field.label} inline><Switch checked={v !== false} onCheckedChange={set} /></FieldRow>
    case 'range':
      return <FieldRow label={field.label}><RangeInput value={Number(v ?? field.min)} onChange={set} min={field.min} max={field.max} step={field.step} unit={field.unit} /></FieldRow>
    case 'category':
      return <CategoryField label={field.label} value={str} onChange={set} hidden={settings.source !== 'category'} />
    case 'categories':
      return <CategoriesField label={field.label} hint={field.hint} value={Array.isArray(v) ? (v as string[]) : []} onChange={set} />
    case 'list':
      return <ListField label={field.label} item={field.item} max={field.max} hint={field.hint} value={Array.isArray(v) ? (v as Array<Record<string, string>>) : []} onChange={set} />
  }
}

function CategoryField({ label, value, onChange, hidden }: { label: string; value: string; onChange: (v: string) => void; hidden: boolean }) {
  const categories = useQuery({ queryKey: ['storefront-categories'], queryFn: getCategories, staleTime: 10 * 60_000 })
  if (hidden) return null
  return (
    <FieldRow label={label}>
      <SelectInput value={value} onChange={onChange} options={[{ value: '', label: 'Choose a category' }, ...(categories.data ?? []).map((c) => ({ value: c.slug, label: c.name }))]} />
    </FieldRow>
  )
}

function CategoriesField({ label, hint, value, onChange }: { label: string; hint?: string; value: string[]; onChange: (v: string[]) => void }) {
  const categories = useQuery({ queryKey: ['storefront-categories'], queryFn: getCategories, staleTime: 10 * 60_000 })
  return (
    <FieldRow label={label} hint={hint}>
      <div className="max-h-48 divide-y overflow-y-auto rounded-lg border border-zinc-300 dark:border-zinc-700">
        {(categories.data ?? []).map((c) => (
          <label key={c.id} className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[13px]">
            <Checkbox checked={value.includes(c.slug)} onCheckedChange={(on) => onChange(on ? [...value, c.slug] : value.filter((x) => x !== c.slug))} />
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <span className="text-[11px] text-zinc-500">{c.product_count}</span>
          </label>
        ))}
        {!categories.data?.length && <p className="p-2.5 text-xs text-zinc-500">No categories yet.</p>}
      </div>
    </FieldRow>
  )
}

export function ListField({ label, item, max, value, onChange, hint }: { label: string; item: Array<{ key: string; label: string; multiline?: boolean }>; max: number; value: Array<Record<string, string>>; onChange: (v: Array<Record<string, string>>) => void; hint?: string }) {
  return (
    <FieldRow label={label} hint={hint}>
      <div className="grid gap-2">
        {value.map((row, i) => (
          <div key={i} className="grid gap-1.5 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
            {item.map((f) => f.multiline
              ? <textarea key={f.key} rows={3} className={cn(inputClass, 'h-auto py-1.5')} aria-label={`${f.label} ${i + 1}`} placeholder={f.label} value={row[f.key] ?? ''}
                  onChange={(e) => onChange(value.map((r, j) => (j === i ? { ...r, [f.key]: e.target.value } : r)))} />
              : <input key={f.key} className={inputClass} aria-label={`${f.label} ${i + 1}`} placeholder={f.label} value={row[f.key] ?? ''}
                  onChange={(e) => onChange(value.map((r, j) => (j === i ? { ...r, [f.key]: e.target.value } : r)))} />)}
            {value.length > 1 && (
              <div className="flex gap-3 justify-self-start text-[11px] text-zinc-500">
                {i > 0 && <button type="button" className="hover:underline" onClick={() => onChange([...value.slice(0, i - 1), row, value[i - 1], ...value.slice(i + 1)])}>Move up</button>}
                {i < value.length - 1 && <button type="button" className="hover:underline" onClick={() => onChange([...value.slice(0, i), value[i + 1], row, ...value.slice(i + 2)])}>Move down</button>}
              </div>
            )}
            <button type="button" className="flex items-center gap-1 justify-self-end text-[11px] text-red-600 hover:underline" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 className="size-3" /> Remove
            </button>
          </div>
        ))}
        {value.length < max && (
          <button type="button" onClick={() => onChange([...value, Object.fromEntries(item.map((f) => [f.key, '']))])}
            className="flex items-center gap-1.5 text-[13px] font-medium text-[#2c6ecb] hover:underline"><Plus className="size-3.5" /> Add</button>
        )}
      </div>
    </FieldRow>
  )
}
