import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, Boxes, ClipboardList, Image as ImageIcon, ImagePlus, Link2, Package, Plus, Search as SearchIcon, Tag, Trash2, Truck, Wallet, Wand2, X,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from '@/lib/toast'
import { z } from 'zod'
import { Field } from '@/components/common/field'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { toUserMessage } from '@/lib/errors'
import { formatMoney, slugify, toNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  type AdminProduct, addProductImageUrl, deleteProductImage, getAdminProduct, imageUrl, listCategories, reorderProductImages, saveCategory,
  saveProduct, uploadProductImage,
} from '@/services/catalog'

const optionalNumber = z.union([z.literal(''), z.coerce.number().min(0)]).optional()

const schema = z.object({
  name: z.string().trim().min(2, 'Name is required'),
  slug: z.string().trim(),
  sku: z.string().trim(),
  description: z.string(),
  short_description: z.string().max(600, 'Keep it under 600 characters'),
  category_id: z.string(),
  extra_category_ids: z.array(z.string()),
  brand: z.string().trim(),
  tags: z.string(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']),
  price: z.coerce.number().min(0, 'Price cannot be negative'),
  compare_at_price: optionalNumber,
  cost_price: z.coerce.number().min(0),
  weight_grams: optionalNumber,
  low_stock_threshold: optionalNumber,
  track_inventory: z.boolean(),
  requires_production: z.boolean(),
  is_featured: z.boolean(),
  seo_title: z.string(),
  seo_description: z.string(),
  option_names: z.string(),
  shipping_note: z.string().max(600),
  admin_note: z.string().max(2000),
  warranty: z.string().max(2000),
  variants: z.array(z.object({
    id: z.string().optional(),
    sku: z.string().trim().min(1, 'SKU required'),
    title: z.string().trim(),
    size: z.string().trim(),
    color: z.string().trim(),
    price: optionalNumber,
    compare_at_price: optionalNumber,
    cost_price: optionalNumber,
    is_active: z.boolean(),
    initial_stock: z.coerce.number().int().min(0).optional(),
  })).min(1),
})
type Values = z.input<typeof schema>
type Parsed = z.output<typeof schema>

const num = (v: unknown) => (v === '' || v === undefined || v === null ? null : Number(v))

function toForm(p?: AdminProduct): Values {
  return {
    name: p?.name ?? '', slug: p?.slug ?? '', sku: p?.sku ?? '', description: p?.description ?? '', short_description: p?.short_description ?? '',
    category_id: p?.category_id ?? '', extra_category_ids: p?.extra_category_ids ?? [],
    brand: p?.brand ?? '', tags: (p?.tags ?? []).join(', '), status: p?.status ?? 'ACTIVE', price: p?.price ?? '',
    compare_at_price: p?.compare_at_price ?? '', cost_price: p?.cost_price ?? '', weight_grams: p?.weight_grams ?? '',
    low_stock_threshold: p?.low_stock_threshold ?? '', track_inventory: p?.track_inventory ?? true,
    requires_production: p?.requires_production ?? false, is_featured: p?.is_featured ?? false,
    seo_title: p?.seo_title ?? '', seo_description: p?.seo_description ?? '', option_names: (p?.option_names ?? []).join(', '),
    shipping_note: p?.shipping_note ?? '', admin_note: p?.admin_note ?? '', warranty: p?.warranty ?? '',
    variants: p?.product_variants.length
      ? [...p.product_variants].sort((a, b) => a.position - b.position).map((v) => ({
          id: v.id, sku: v.sku, title: v.title, size: v.size ?? '', color: v.color ?? '', price: v.price ?? '',
          compare_at_price: v.compare_at_price ?? '', cost_price: v.cost_price ?? '', is_active: v.is_active,
        }))
      : [{ sku: '', title: 'Default', size: '', color: '', price: '', compare_at_price: '', cost_price: '', is_active: true, initial_stock: 0 }],
  }
}

/** Images chosen before a new product exists; uploaded right after the first save. */
type Pending = { key: string; file?: File; url: string }

export default function ProductEditPage() {
  const { id } = useParams()
  const isNew = !id
  const navigate = useNavigate()
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const canEdit = can('products.manage')
  const product = useQuery({ queryKey: ['product-admin', id], enabled: !isNew, queryFn: () => getAdminProduct(id!) })
  // `values` (not a reset in an effect) so selects and switches show the saved product too.
  const loaded = useMemo(() => (product.data ? toForm(product.data) : undefined), [product.data])
  const form = useForm<Values, unknown, Parsed>({ resolver: zodResolver(schema), defaultValues: toForm(), values: loaded })
  const variants = useFieldArray({ control: form.control, name: 'variants' })
  const [pending, setPending] = useState<Pending[]>([])

  const save = useMutation({
    mutationFn: async (v: Parsed) => {
      const optionNames = v.option_names.split(',').map((t) => t.trim()).filter(Boolean)
      const saved = await saveProduct({
        id, name: v.name, slug: v.slug || slugify(v.name), sku: v.sku || null, description: v.description || null,
        short_description: v.short_description || null, category_id: v.category_id || null,
        extra_category_ids: v.extra_category_ids.filter((c) => c !== v.category_id), brand: v.brand || null,
        tags: v.tags.split(',').map((t) => t.trim()).filter(Boolean), status: v.status, option_names: optionNames,
        price: v.price, compare_at_price: num(v.compare_at_price), cost_price: v.cost_price, weight_grams: num(v.weight_grams),
        low_stock_threshold: num(v.low_stock_threshold), track_inventory: v.track_inventory, requires_production: v.requires_production,
        is_featured: v.is_featured, seo_title: v.seo_title || null, seo_description: v.seo_description || null,
        shipping_note: v.shipping_note || null, admin_note: v.admin_note || null, warranty: v.warranty || null,
        variants: v.variants.map((variant) => {
          const optionValues: Record<string, string> = {}
          for (const name of optionNames) {
            const value = /size/i.test(name) ? variant.size : /colou?r/i.test(name) ? variant.color : ''
            if (value) optionValues[name] = value
          }
          return {
            id: variant.id, sku: variant.sku, title: variant.title || [variant.size, variant.color].filter(Boolean).join(' / ') || 'Default',
            size: variant.size || null, color: variant.color || null, option_values: optionValues,
            price: num(variant.price), compare_at_price: num(variant.compare_at_price), cost_price: num(variant.cost_price),
            is_active: variant.is_active, initial_stock: variant.id ? undefined : variant.initial_stock ?? 0,
          }
        }),
      })
      // Images picked while creating: the product exists now, so add them.
      let failed = 0
      for (const [i, img] of pending.entries()) {
        try {
          if (img.file) await uploadProductImage(saved.id, img.file, i, i === 0)
          else await addProductImageUrl(saved.id, img.url, i, i === 0)
        } catch { failed++ }
      }
      return { saved, failed }
    },
    onSuccess: ({ saved, failed }) => {
      toast.success('Product saved')
      if (failed) toast.error(`${failed} image${failed === 1 ? '' : 's'} could not be added — add them again from the product`)
      setPending([])
      void queryClient.invalidateQueries({ queryKey: ['products'] })
      void queryClient.invalidateQueries({ queryKey: ['product-stats'] })
      void queryClient.invalidateQueries({ queryKey: ['product-admin', saved?.id] })
      if (isNew && saved?.id) navigate(`/admin/products/${saved.id}`, { replace: true })
    },
  })

  if (!isNew && product.isLoading) return <LoadingState />
  if (!isNew && (product.error || !product.data)) return <ErrorState error={product.error ?? new Error('NOT_FOUND: Product not found')} />
  const e = form.formState.errors
  const inventoryByVariant = new Map((product.data?.product_variants ?? []).map((v) => [v.id, v.inventory]))

  return (
    <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="mx-auto max-w-5xl space-y-4 pb-24" noValidate>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="icon-sm" variant="ghost" asChild><Link to="/admin/products" aria-label="Back to products"><ArrowLeft /></Link></Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{isNew ? 'New product' : 'Edit product'}</h1>
          {!isNew && <p className="truncate text-xs text-muted-foreground">{product.data?.name}</p>}
        </div>
        <Controller control={form.control} name="status" render={({ field }) => (
          <Select value={field.value} onValueChange={field.onChange} disabled={!canEdit}>
            <SelectTrigger size="sm" className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="ACTIVE">Active</SelectItem><SelectItem value="DRAFT">Draft</SelectItem><SelectItem value="ARCHIVED">Archived</SelectItem></SelectContent>
          </Select>
        )} />
      </div>
      {save.error && <p className="rounded-md border border-foreground/30 p-3 text-sm">{toUserMessage(save.error)}</p>}

      <fieldset disabled={!canEdit} className="space-y-4">
        <Section icon={<Package />} title="Product">
          <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
            <Field label="Product name" htmlFor="p-name" error={e.name?.message} required><Input id="p-name" {...form.register('name')} placeholder="e.g. Premium Cotton Panjabi" /></Field>
            <Field label="Product code (SKU)" htmlFor="p-sku"><Input id="p-sku" {...form.register('sku')} placeholder="PJ-101" /></Field>
          </div>
        </Section>

        <Section icon={<Wallet />} title="Pricing">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Cost price" htmlFor="p-cost" error={e.cost_price?.message}><MoneyInput id="p-cost" {...form.register('cost_price')} /></Field>
            <Field label="Sell price" htmlFor="p-price" error={e.price?.message} required><MoneyInput id="p-price" {...form.register('price')} /></Field>
            <Field label="Website regular price" htmlFor="p-compare" hint="Shown crossed out when higher"><MoneyInput id="p-compare" {...form.register('compare_at_price')} /></Field>
          </div>
          <ProfitBar control={form.control} />
        </Section>

        <Section icon={<Boxes />} title="Inventory">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Alert quantity" htmlFor="p-low" hint="Warn when stock falls to this"><Input id="p-low" type="number" min="0" {...form.register('low_stock_threshold')} placeholder="5" /></Field>
            <Toggle control={form.control} name="track_inventory" label="Manage stock" detail="Count stock and stop overselling" />
            <Toggle control={form.control} name="is_featured" label="Featured product" detail="Shown on the home page" />
          </div>
          <Toggle control={form.control} name="requires_production" label="Made to order" detail="Goes to production after it is ordered" />
          <VariantsEditor form={form} variants={variants} isNew={isNew} canEdit={canEdit} inventoryByVariant={inventoryByVariant} />
        </Section>

        <Section icon={<ImageIcon />} title="Media & images">
          {isNew || !product.data
            ? <PendingImages pending={pending} setPending={setPending} canEdit={canEdit} />
            : <SavedImages product={product.data} canEdit={canEdit} />}
        </Section>

        <Section icon={<Tag />} title="Catalog info">
          <Field label="Short description" htmlFor="p-short" error={e.short_description?.message} hint="One or two lines under the price on the product page">
            <Textarea id="p-short" rows={2} {...form.register('short_description')} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Controller control={form.control} name="category_id" render={({ field }) => (
              <Field label="Main category">
                <CategorySelect value={field.value} onChange={field.onChange} />
              </Field>
            )} />
            <Field label="Brand" htmlFor="p-brand"><Input id="p-brand" {...form.register('brand')} /></Field>
          </div>
          <Controller control={form.control} name="extra_category_ids" render={({ field }) => (
            <Field label="Additional categories" hint="The product also shows in these">
              <MultiCategory value={field.value} onChange={field.onChange} exclude={form.getValues('category_id')} canEdit={canEdit} />
            </Field>
          )} />
          <Field label="Long description" htmlFor="p-desc"><Textarea id="p-desc" rows={6} {...form.register('description')} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tags" htmlFor="p-tags" hint="Comma separated"><Input id="p-tags" {...form.register('tags')} /></Field>
            <Field label="Option names" htmlFor="p-options" hint="e.g. Size, Color"><Input id="p-options" {...form.register('option_names')} /></Field>
          </div>
        </Section>

        <Section icon={<Truck />} title="Shipping specs">
          <Controller control={form.control} name="weight_grams" render={({ field }) => (
            <Field label="Product weight" hint="Used for courier charges by weight"><WeightInput value={field.value} onChange={field.onChange} /></Field>
          )} />
        </Section>

        <Section icon={<ClipboardList />} title="Extra details">
          <Field label="Default shipping note" htmlFor="p-ship" hint="Shown to customers, e.g. “Ships in 2–3 days”"><Textarea id="p-ship" rows={2} {...form.register('shipping_note')} /></Field>
          <Field label="Warranty policy" htmlFor="p-warranty" hint="Shown on the product page"><Textarea id="p-warranty" rows={2} {...form.register('warranty')} /></Field>
          <Field label="Internal admin note" htmlFor="p-admin" hint="Staff only — never shown to customers"><Textarea id="p-admin" rows={2} {...form.register('admin_note')} /></Field>
        </Section>

        <Section icon={<SearchIcon />} title="Search engine listing">
          <Field label="URL handle" htmlFor="p-slug" hint={`/product/${form.watch('slug') || slugify(form.watch('name') || '')}`}><Input id="p-slug" {...form.register('slug')} /></Field>
          <Field label="Page title" htmlFor="p-seo-title"><Input id="p-seo-title" {...form.register('seo_title')} /></Field>
          <Field label="Meta description" htmlFor="p-seo-desc"><Textarea id="p-seo-desc" rows={2} {...form.register('seo_description')} /></Field>
        </Section>
      </fieldset>

      {canEdit && (
        <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-end gap-2 border-t bg-background/95 px-1 py-3 backdrop-blur">
          <Button type="button" variant="ghost" asChild><Link to="/admin/products">Cancel</Link></Button>
          <Button type="submit" disabled={save.isPending}>{save.isPending && <Spinner />} {isNew ? 'Create product' : 'Save changes'}</Button>
        </div>
      )}
    </form>
  )
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2 border-b px-5 py-3 text-sm font-semibold [&_svg]:size-4 [&_svg]:text-muted-foreground">{icon}{title}</div>
      <CardContent className="space-y-4 py-5">{children}</CardContent>
    </Card>
  )
}

function MoneyInput(props: React.ComponentProps<typeof Input>) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">৳</span>
      <Input type="number" step="0.01" min="0" className="pl-7" placeholder="0.00" {...props} />
    </div>
  )
}

function ProfitBar({ control }: { control: ReturnType<typeof useForm<Values, unknown, Parsed>>['control'] }) {
  const [price, cost] = useWatch({ control, name: ['price', 'cost_price'] })
  const p = toNumber(price)
  const c = toNumber(cost)
  const profit = p - c
  const margin = p > 0 ? (profit / p) * 100 : 0
  const label = p <= 0 ? 'Set a sell price' : profit > 0 ? 'Profitable' : profit === 0 ? 'Break-even' : 'Loss'
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3">
      <div>
        <p className="text-xs text-muted-foreground">Projected profit</p>
        <p className="text-lg font-semibold tabular-nums">{formatMoney(profit)} <span className="text-sm font-normal text-muted-foreground">(margin {margin.toFixed(1)}%)</span></p>
      </div>
      <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
        profit > 0 && p > 0 ? 'bg-foreground text-background' : 'ring-1 ring-inset ring-foreground/40')}>{label}</span>
    </div>
  )
}

function Toggle({ control, name, label, detail }: { control: ReturnType<typeof useForm<Values, unknown, Parsed>>['control']; name: 'track_inventory' | 'is_featured' | 'requires_production'; label: string; detail: string }) {
  return (
    <Controller control={control} name={name} render={({ field }) => (
      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
        <span><span className="block text-sm font-medium">{label}</span><span className="block text-xs text-muted-foreground">{detail}</span></span>
        <Switch checked={field.value} onCheckedChange={field.onChange} />
      </label>
    )} />
  )
}

function WeightInput({ value, onChange }: { value: Values['weight_grams']; onChange: (v: string | number) => void }) {
  const [unit, setUnit] = useState<'kg' | 'g'>(() => (toNumber(value) >= 1000 ? 'kg' : 'g'))
  const grams = value === '' || value === undefined || value === null ? null : toNumber(value)
  const shown = grams === null ? '' : unit === 'kg' ? String(grams / 1000) : String(grams)
  return (
    <div className="flex max-w-xs">
      <Input type="number" min="0" step={unit === 'kg' ? '0.001' : '1'} value={shown} className="rounded-r-none" placeholder="0"
        onChange={(ev) => onChange(ev.target.value === '' ? '' : Math.round(Number(ev.target.value) * (unit === 'kg' ? 1000 : 1)))} />
      <div className="flex rounded-r-md border border-l-0 p-0.5">
        {(['kg', 'g'] as const).map((u) => (
          <button key={u} type="button" onClick={() => setUnit(u)}
            className={cn('rounded px-3 text-sm transition-colors', unit === u ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>{u}</button>
        ))}
      </div>
    </div>
  )
}

function CategorySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories })
  return (
    // Radix reports '' while its options are still loading; that is not a choice.
    <Select value={value || 'none'} onValueChange={(v) => { if (v) onChange(v === 'none' ? '' : v) }}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="none">None</SelectItem>{(categories.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
    </Select>
  )
}

function MultiCategory({ value, onChange, exclude, canEdit }: { value: string[]; onChange: (v: string[]) => void; exclude: string; canEdit: boolean }) {
  const queryClient = useQueryClient()
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories })
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const all = categories.data ?? []
  const options = all.filter((c) => c.id !== exclude && !value.includes(c.id))
  const create = useMutation({
    mutationFn: () => saveCategory({ name: name.trim(), slug: slugify(name), is_active: true, sort_order: 0 }),
    onSuccess: (c) => {
      toast.success(`Category “${c.name}” created`)
      onChange([...value, c.id]); setName(''); setCreating(false)
      void queryClient.invalidateQueries({ queryKey: ['categories'] })
    },
    onError: (err) => toast.error(toUserMessage(err)),
  })
  return (
    <div className="space-y-2">
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5">
        {value.map((id) => (
          <span key={id} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs animate-in fade-in-0 zoom-in-95">
            {all.find((c) => c.id === id)?.name ?? '…'}
            {canEdit && <button type="button" onClick={() => onChange(value.filter((v) => v !== id))} aria-label="Remove category"><X className="size-3" /></button>}
          </span>
        ))}
        {canEdit && options.length > 0 && (
          <Select value="" onValueChange={(v) => onChange([...value, v])}>
            <SelectTrigger size="sm" className="h-7 w-auto border-0 px-1 text-xs text-muted-foreground shadow-none"><SelectValue placeholder="Add category" /></SelectTrigger>
            <SelectContent>{options.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
        )}
        {!value.length && !canEdit && <span className="text-xs text-muted-foreground">None</span>}
      </div>
      {canEdit && (creating ? (
        <div className="flex max-w-sm gap-2 animate-in fade-in-0 slide-in-from-top-1">
          <Input autoFocus value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Category name" className="h-8"
            onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); if (name.trim()) create.mutate() } if (ev.key === 'Escape') setCreating(false) }} />
          <Button type="button" size="sm" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>{create.isPending ? <Spinner /> : 'Add'}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
        </div>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => setCreating(true)}><Plus /> Create category</Button>
      ))}
    </div>
  )
}

type FormApi = ReturnType<typeof useForm<Values, unknown, Parsed>>
function VariantsEditor({ form, variants, isNew, canEdit, inventoryByVariant }: {
  form: FormApi; variants: ReturnType<typeof useFieldArray<Values, 'variants'>>; isNew: boolean; canEdit: boolean
  inventoryByVariant: Map<string, { available: number | null; on_hand: number } | null>
}) {
  const [open, setOpen] = useState(() => form.getValues('variants').length > 1)
  const [sizes, setSizes] = useState('')
  const [colors, setColors] = useState('')
  const e = form.formState.errors
  const single = variants.fields.length === 1 && !open

  const generate = () => {
    const s = sizes.split(',').map((x) => x.trim()).filter(Boolean)
    const c = colors.split(',').map((x) => x.trim()).filter(Boolean)
    if (!s.length && !c.length) return
    const base = (form.getValues('sku') || slugify(form.getValues('name')).toUpperCase().slice(0, 10) || 'SKU').replace(/-+$/, '')
    const existing = new Set(form.getValues('variants').map((v) => `${v.size}|${v.color}`))
    const combos = (s.length ? s : ['']).flatMap((size) => (c.length ? c : ['']).map((color) => ({ size, color })))
    const current = form.getValues('variants')
    if (current.length === 1 && !current[0].id && !current[0].size && !current[0].color) variants.remove(0)
    for (const x of combos.filter((x) => !existing.has(`${x.size}|${x.color}`))) {
      variants.append({
        sku: [base, x.color.slice(0, 3).toUpperCase(), x.size.toUpperCase()].filter(Boolean).join('-'),
        title: [x.size, x.color].filter(Boolean).join(' / '), size: x.size, color: x.color,
        price: '', compare_at_price: '', cost_price: '', is_active: true, initial_stock: 0,
      })
    }
    form.setValue('option_names', [s.length ? 'Size' : '', c.length ? 'Color' : ''].filter(Boolean).join(', '))
  }

  if (single) {
    const vid = form.getValues('variants.0.id')
    const inv = vid ? inventoryByVariant.get(vid) : undefined
    return (
      <div className="flex flex-wrap items-end gap-4 rounded-lg border border-dashed p-3">
        <Field label="Variant SKU" htmlFor="v0-sku" error={e.variants?.[0]?.sku?.message}><Input id="v0-sku" className="w-44" {...form.register('variants.0.sku')} placeholder="PJ-101" /></Field>
        {vid
          ? <div className="text-sm"><p className="text-xs text-muted-foreground">In stock</p><p className="font-medium tabular-nums">{inv ? `${inv.available ?? 0} available · ${inv.on_hand} on hand` : '—'}</p></div>
          : <Field label="Opening stock" htmlFor="v0-stock"><Input id="v0-stock" type="number" min="0" className="w-28" {...form.register('variants.0.initial_stock')} /></Field>}
        {canEdit && <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setOpen(true)}><Wand2 /> Add sizes / colours</Button>}
      </div>
    )
  }

  return (
    <div className="space-y-3 animate-in fade-in-0">
      {canEdit && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg bg-muted/50 p-3">
          <Field label="Sizes" htmlFor="gen-sizes"><Input id="gen-sizes" value={sizes} onChange={(ev) => setSizes(ev.target.value)} placeholder="S, M, L, XL" className="w-40" /></Field>
          <Field label="Colours" htmlFor="gen-colors"><Input id="gen-colors" value={colors} onChange={(ev) => setColors(ev.target.value)} placeholder="Black, White" className="w-40" /></Field>
          <Button type="button" variant="outline" size="sm" onClick={generate}><Wand2 /> Generate variants</Button>
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[720px] text-sm">
          <thead><tr className="bg-muted/40 text-left text-xs text-muted-foreground">
            <th className="p-2">SKU</th><th className="p-2">Size</th><th className="p-2">Colour</th><th className="p-2">Price</th><th className="p-2">Cost</th>
            <th className="p-2">{isNew ? 'Opening stock' : 'Stock'}</th><th className="p-2">Active</th><th />
          </tr></thead>
          <tbody>
            {variants.fields.map((field, idx) => {
              const vid = form.getValues(`variants.${idx}.id`)
              const inv = vid ? inventoryByVariant.get(vid) : undefined
              return (
                <tr key={field.id} className="border-t">
                  <td className="p-1.5"><Input className="h-8" {...form.register(`variants.${idx}.sku`)} aria-invalid={!!e.variants?.[idx]?.sku} aria-label="Variant SKU" /></td>
                  <td className="p-1.5"><Input className="h-8 w-20" {...form.register(`variants.${idx}.size`)} aria-label="Size" /></td>
                  <td className="p-1.5"><Input className="h-8 w-24" {...form.register(`variants.${idx}.color`)} aria-label="Colour" /></td>
                  <td className="p-1.5"><Input className="h-8 w-24" type="number" step="0.01" placeholder="Same" {...form.register(`variants.${idx}.price`)} aria-label="Variant price" /></td>
                  <td className="p-1.5"><Input className="h-8 w-24" type="number" step="0.01" placeholder="Same" {...form.register(`variants.${idx}.cost_price`)} aria-label="Variant cost" /></td>
                  <td className="p-1.5">
                    {vid ? <span className="text-xs whitespace-nowrap tabular-nums">{inv ? `${inv.available ?? 0} avail · ${inv.on_hand} on hand` : '—'}</span>
                      : <Input className="h-8 w-20" type="number" min="0" {...form.register(`variants.${idx}.initial_stock`)} aria-label="Opening stock" />}
                  </td>
                  <td className="p-1.5"><Controller control={form.control} name={`variants.${idx}.is_active`} render={({ field: f }) => <Switch checked={f.value} onCheckedChange={f.onChange} aria-label="Active" />} /></td>
                  <td className="p-1.5">{!vid && variants.fields.length > 1 && <Button type="button" size="icon-sm" variant="ghost" onClick={() => variants.remove(idx)} aria-label="Remove variant"><Trash2 /></Button>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <Button type="button" variant="outline" size="sm" onClick={() => variants.append({ sku: '', title: '', size: '', color: '', price: '', compare_at_price: '', cost_price: '', is_active: true, initial_stock: 0 })}>
          <Plus /> Add variant
        </Button>
      )}
      <p className="text-xs text-muted-foreground">Leave price or cost empty to use the product's. Change stock from the product list or <Link to="/admin/inventory" className="underline">Inventory</Link> — every change is recorded.</p>
    </div>
  )
}

function DropZone({ onFiles, busy, children }: { onFiles: (files: File[]) => void; busy?: boolean; children?: ReactNode }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={(ev) => { ev.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(ev) => { ev.preventDefault(); setOver(false); const files = Array.from(ev.dataTransfer.files).filter((f) => f.type.startsWith('image/')); if (files.length) onFiles(files) }}
      onClick={() => input.current?.click()}
      role="button" tabIndex={0} onKeyDown={(ev) => ev.key === 'Enter' && input.current?.click()}
      className={cn('flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-all duration-200',
        over ? 'scale-[1.01] border-foreground bg-muted/60' : 'hover:border-foreground/40 hover:bg-muted/30')}>
      {busy ? <Spinner /> : <ImagePlus className="size-6 text-muted-foreground" />}
      <p className="text-sm font-medium">Drag & drop images here</p>
      <p className="text-xs text-muted-foreground">or click to choose · JPG, PNG or WebP up to 5 MB</p>
      {children}
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(ev) => { const f = Array.from(ev.target.files ?? []); if (f.length) onFiles(f); ev.target.value = '' }} />
    </div>
  )
}

function UrlAdder({ onAdd, busy }: { onAdd: (url: string) => void; busy?: boolean }) {
  const [url, setUrl] = useState('')
  const valid = /^https:\/\/\S+$/i.test(url.trim())
  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <Link2 className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={url} onChange={(ev) => setUrl(ev.target.value)} placeholder="https://…/image.jpg" className="pl-8"
          onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); if (valid) { onAdd(url.trim()); setUrl('') } } }} />
      </div>
      <Button type="button" variant="outline" disabled={!valid || busy} onClick={() => { onAdd(url.trim()); setUrl('') }}>Add image URL to gallery</Button>
    </div>
  )
}

function Thumb({ src, main, onMain, onRemove, canEdit }: { src: string; main: boolean; onMain?: () => void; onRemove?: () => void; canEdit: boolean }) {
  return (
    <div className={cn('group relative overflow-hidden rounded-lg border bg-muted animate-in fade-in-0 zoom-in-95 duration-300', main && 'ring-2 ring-foreground')}>
      <img src={src} alt="" className="aspect-square w-full object-cover" onError={(ev) => { ev.currentTarget.style.opacity = '0.2' }} />
      {main && <span className="absolute top-1.5 left-1.5 rounded bg-foreground px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-background">MAIN</span>}
      {canEdit && (
        <div className="absolute inset-x-0 bottom-0 flex translate-y-full justify-between bg-background/95 p-1 transition-transform duration-200 group-hover:translate-y-0 group-focus-within:translate-y-0">
          {!main && onMain ? <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onMain}>Set main</Button> : <span />}
          {onRemove && <Button type="button" size="icon-sm" variant="ghost" onClick={onRemove} aria-label="Remove image"><Trash2 /></Button>}
        </div>
      )}
    </div>
  )
}

function PendingImages({ pending, setPending, canEdit }: { pending: Pending[]; setPending: React.Dispatch<React.SetStateAction<Pending[]>>; canEdit: boolean }) {
  useEffect(() => () => pending.forEach((p) => p.file && URL.revokeObjectURL(p.url)), []) // eslint-disable-line react-hooks/exhaustive-deps
  const add = (files: File[]) => {
    const ok = files.filter((f) => f.size <= 5 * 1024 * 1024)
    if (ok.length < files.length) toast.error('Images must be smaller than 5 MB')
    setPending((p) => [...p, ...ok.map((file) => ({ key: crypto.randomUUID(), file, url: URL.createObjectURL(file) }))])
  }
  return (
    <div className="space-y-3">
      {canEdit && <DropZone onFiles={add} />}
      {canEdit && <UrlAdder onAdd={(url) => setPending((p) => [...p, { key: crypto.randomUUID(), url }])} />}
      {pending.length > 0 && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
          {pending.map((img, i) => (
            <Thumb key={img.key} src={img.url} main={i === 0} canEdit={canEdit}
              onMain={() => setPending((p) => [img, ...p.filter((x) => x.key !== img.key)])}
              onRemove={() => setPending((p) => p.filter((x) => x.key !== img.key))} />
          ))}
        </div>
      )}
      {pending.length > 0 && <p className="text-xs text-muted-foreground">Images are added when you create the product.</p>}
    </div>
  )
}

function SavedImages({ product, canEdit }: { product: AdminProduct; canEdit: boolean }) {
  const queryClient = useQueryClient()
  const images = [...product.product_images].sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.position - b.position)
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['product-admin', product.id] })
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      let pos = images.length
      for (const file of files) await uploadProductImage(product.id, file, pos++, images.length === 0 && pos === 1)
    },
    onSuccess: () => { toast.success('Images uploaded'); void refresh() },
    onError: (err) => toast.error(toUserMessage(err)),
  })
  const addUrl = useMutation({
    mutationFn: (url: string) => addProductImageUrl(product.id, url, images.length, images.length === 0),
    onSuccess: () => { toast.success('Image added'); void refresh() },
    onError: (err) => toast.error(toUserMessage(err)),
  })
  const remove = useMutation({ mutationFn: deleteProductImage, onSuccess: () => void refresh() })
  const setMain = useMutation({
    mutationFn: (id: string) => reorderProductImages(product.id, images.map((i) => i.id), id),
    onSuccess: () => void refresh(),
  })
  return (
    <div className="space-y-3">
      {canEdit && <DropZone onFiles={(f) => upload.mutate(f)} busy={upload.isPending} />}
      {canEdit && <UrlAdder onAdd={(u) => addUrl.mutate(u)} busy={addUrl.isPending} />}
      {images.length > 0 ? (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
          {images.map((img) => (
            <Thumb key={img.id} src={imageUrl(img.url, 300) ?? img.url} main={img.is_primary} canEdit={canEdit}
              onMain={() => setMain.mutate(img.id)} onRemove={() => remove.mutate(img)} />
          ))}
        </div>
      ) : <p className="text-sm text-muted-foreground">No images yet.</p>}
    </div>
  )
}
