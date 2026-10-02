import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowLeft, ArrowUp, ImagePlus, Star, Trash2, Wand2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Controller, useFieldArray, useForm } from 'react-hook-form'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { toUserMessage } from '@/lib/errors'
import { formatMoney, slugify, toNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  type AdminProduct, deleteProductImage, getAdminProduct, imageUrl, listCategories, reorderProductImages, saveProduct, uploadProductImage,
} from '@/services/catalog'

const optionalNumber = z.union([z.literal(''), z.coerce.number().min(0)]).optional()

const schema = z.object({
  name: z.string().trim().min(2, 'Name is required'),
  slug: z.string().trim(),
  sku: z.string().trim(),
  description: z.string(),
  category_id: z.string(),
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
    name: p?.name ?? '', slug: p?.slug ?? '', sku: p?.sku ?? '', description: p?.description ?? '', category_id: p?.category_id ?? '',
    brand: p?.brand ?? '', tags: (p?.tags ?? []).join(', '), status: p?.status ?? 'DRAFT', price: p?.price ?? 0,
    compare_at_price: p?.compare_at_price ?? '', cost_price: p?.cost_price ?? 0, weight_grams: p?.weight_grams ?? '',
    low_stock_threshold: p?.low_stock_threshold ?? '', track_inventory: p?.track_inventory ?? true,
    requires_production: p?.requires_production ?? false, is_featured: p?.is_featured ?? false,
    seo_title: p?.seo_title ?? '', seo_description: p?.seo_description ?? '', option_names: (p?.option_names ?? []).join(', '),
    variants: p?.product_variants.length
      ? [...p.product_variants].sort((a, b) => a.position - b.position).map((v) => ({
          id: v.id, sku: v.sku, title: v.title, size: v.size ?? '', color: v.color ?? '', price: v.price ?? '',
          compare_at_price: v.compare_at_price ?? '', cost_price: v.cost_price ?? '', is_active: v.is_active,
        }))
      : [{ sku: '', title: 'Default', size: '', color: '', price: '', compare_at_price: '', cost_price: '', is_active: true, initial_stock: 0 }],
  }
}

export default function ProductEditPage() {
  const { id } = useParams()
  const isNew = !id
  const navigate = useNavigate()
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const canEdit = can('products.manage')
  const product = useQuery({ queryKey: ['product-admin', id], enabled: !isNew, queryFn: () => getAdminProduct(id!) })
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories })
  const form = useForm<Values, unknown, Parsed>({ resolver: zodResolver(schema), defaultValues: toForm() })
  const variants = useFieldArray({ control: form.control, name: 'variants' })
  const [sizes, setSizes] = useState('')
  const [colors, setColors] = useState('')

  useEffect(() => {
    if (product.data) form.reset(toForm(product.data))
  }, [product.data, form])

  const save = useMutation({
    mutationFn: (v: Parsed) => saveProduct({
      id: id, name: v.name, slug: v.slug || slugify(v.name), sku: v.sku || null, description: v.description || null,
      category_id: v.category_id || null, brand: v.brand || null,
      tags: v.tags.split(',').map((t) => t.trim()).filter(Boolean), status: v.status,
      option_names: v.option_names.split(',').map((t) => t.trim()).filter(Boolean),
      price: v.price, compare_at_price: num(v.compare_at_price), cost_price: v.cost_price, weight_grams: num(v.weight_grams),
      low_stock_threshold: num(v.low_stock_threshold), track_inventory: v.track_inventory, requires_production: v.requires_production,
      is_featured: v.is_featured, seo_title: v.seo_title || null, seo_description: v.seo_description || null,
      variants: v.variants.map((variant) => {
        const optionNames = v.option_names.split(',').map((t) => t.trim()).filter(Boolean)
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
    }),
    onSuccess: (saved) => {
      toast.success('Product saved')
      void queryClient.invalidateQueries({ queryKey: ['products'] })
      void queryClient.invalidateQueries({ queryKey: ['product-admin', saved?.id] })
      if (isNew && saved?.id) navigate(`/admin/products/${saved.id}`, { replace: true })
    },
  })

  const generateVariants = () => {
    const s = sizes.split(',').map((x) => x.trim()).filter(Boolean)
    const c = colors.split(',').map((x) => x.trim()).filter(Boolean)
    if (!s.length && !c.length) return
    const base = (form.getValues('sku') || slugify(form.getValues('name')).toUpperCase().slice(0, 10) || 'SKU').replace(/-+$/, '')
    const existing = new Set(form.getValues('variants').map((v) => `${v.size}|${v.color}`))
    const combos = (s.length ? s : ['']).flatMap((size) => (c.length ? c : ['']).map((color) => ({ size, color })))
    const toAdd = combos.filter((x) => !existing.has(`${x.size}|${x.color}`))
    const current = form.getValues('variants')
    if (current.length === 1 && !current[0].id && !current[0].size && !current[0].color) variants.remove(0)
    for (const x of toAdd) {
      variants.append({
        sku: [base, x.color.slice(0, 3).toUpperCase(), x.size.toUpperCase()].filter(Boolean).join('-'),
        title: [x.size, x.color].filter(Boolean).join(' / '), size: x.size, color: x.color,
        price: '', compare_at_price: '', cost_price: '', is_active: true, initial_stock: 0,
      })
    }
    form.setValue('option_names', [s.length ? 'Size' : '', c.length ? 'Color' : ''].filter(Boolean).join(', '))
  }

  if (!isNew && product.isLoading) return <LoadingState />
  if (!isNew && (product.error || !product.data)) return <ErrorState error={product.error ?? new Error('NOT_FOUND: Product not found')} />
  const e = form.formState.errors
  const inventoryByVariant = new Map((product.data?.product_variants ?? []).map((v) => [v.id, v.inventory]))

  return (
    <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
      <Link to="/admin/products" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Products</Link>
      <PageHeader title={isNew ? 'New product' : product.data?.name}
        actions={canEdit && <Button type="submit" disabled={save.isPending}>{save.isPending && <Spinner />} Save product</Button>} />
      {save.error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-800">{toUserMessage(save.error)}</p>}
      <fieldset disabled={!canEdit} className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="p-name" error={e.name?.message} required className="sm:col-span-2"><Input id="p-name" {...form.register('name')} /></Field>
              <Field label="Description" htmlFor="p-desc" className="sm:col-span-2"><Textarea id="p-desc" rows={5} {...form.register('description')} /></Field>
              <Field label="Price" htmlFor="p-price" error={e.price?.message} required><Input id="p-price" type="number" step="0.01" min="0" {...form.register('price')} /></Field>
              <Field label="Compare-at price" htmlFor="p-compare" hint="Shows a sale badge when higher than the price"><Input id="p-compare" type="number" step="0.01" min="0" {...form.register('compare_at_price')} /></Field>
              <Field label="Cost price" htmlFor="p-cost" hint="Used for COGS and profit"><Input id="p-cost" type="number" step="0.01" min="0" {...form.register('cost_price')} /></Field>
              <Field label="Base SKU" htmlFor="p-sku"><Input id="p-sku" {...form.register('sku')} /></Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Variants</CardTitle>
              <CardDescription>Each variant has its own SKU and stock. Leave price/cost empty to use the product's.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {canEdit && (
                <div className="flex flex-wrap items-end gap-2 rounded-md bg-muted/50 p-3">
                  <Field label="Sizes" htmlFor="gen-sizes"><Input id="gen-sizes" value={sizes} onChange={(ev) => setSizes(ev.target.value)} placeholder="S, M, L, XL" className="w-40" /></Field>
                  <Field label="Colors" htmlFor="gen-colors"><Input id="gen-colors" value={colors} onChange={(ev) => setColors(ev.target.value)} placeholder="Black, White" className="w-40" /></Field>
                  <Button type="button" variant="outline" size="sm" onClick={generateVariants}><Wand2 /> Generate variants</Button>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead><tr className="text-left text-xs text-muted-foreground">
                    <th className="p-1">SKU</th><th className="p-1">Size</th><th className="p-1">Color</th><th className="p-1">Price</th><th className="p-1">Cost</th>
                    <th className="p-1">{isNew ? 'Opening stock' : 'Stock'}</th><th className="p-1">Active</th><th />
                  </tr></thead>
                  <tbody>
                    {variants.fields.map((field, idx) => {
                      const inv = field.id && form.getValues(`variants.${idx}.id`) ? inventoryByVariant.get(form.getValues(`variants.${idx}.id`)!) : undefined
                      const savedVariant = Boolean(form.getValues(`variants.${idx}.id`))
                      return (
                        <tr key={field.id} className="border-t">
                          <td className="p-1"><Input className="h-8" {...form.register(`variants.${idx}.sku`)} aria-invalid={!!e.variants?.[idx]?.sku} aria-label="Variant SKU" /></td>
                          <td className="p-1"><Input className="h-8 w-20" {...form.register(`variants.${idx}.size`)} aria-label="Size" /></td>
                          <td className="p-1"><Input className="h-8 w-24" {...form.register(`variants.${idx}.color`)} aria-label="Color" /></td>
                          <td className="p-1"><Input className="h-8 w-24" type="number" step="0.01" {...form.register(`variants.${idx}.price`)} aria-label="Variant price" /></td>
                          <td className="p-1"><Input className="h-8 w-24" type="number" step="0.01" {...form.register(`variants.${idx}.cost_price`)} aria-label="Variant cost" /></td>
                          <td className="p-1">
                            {savedVariant ? (
                              <span className="text-xs whitespace-nowrap">{inv ? `${inv.available} avail · ${inv.on_hand} on hand` : '—'}</span>
                            ) : (
                              <Input className="h-8 w-20" type="number" min="0" {...form.register(`variants.${idx}.initial_stock`)} aria-label="Opening stock" />
                            )}
                          </td>
                          <td className="p-1"><Controller control={form.control} name={`variants.${idx}.is_active`} render={({ field: f }) => <Switch checked={f.value} onCheckedChange={f.onChange} aria-label="Active" />} /></td>
                          <td className="p-1">
                            {!savedVariant && variants.fields.length > 1 && <Button type="button" size="icon-sm" variant="ghost" onClick={() => variants.remove(idx)} aria-label="Remove variant"><Trash2 /></Button>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {canEdit && (
                <Button type="button" variant="outline" size="sm" onClick={() => variants.append({ sku: '', title: '', size: '', color: '', price: '', compare_at_price: '', cost_price: '', is_active: true, initial_stock: 0 })}>
                  Add variant
                </Button>
              )}
              {!isNew && <p className="text-xs text-muted-foreground">Change stock from <Link to="/admin/inventory" className="underline">Inventory</Link> — every change is recorded as a stock movement. Saved variants are deactivated, never deleted.</p>}
            </CardContent>
          </Card>

          {!isNew && product.data && <ImagesCard product={product.data} canEdit={canEdit} />}

          <Card>
            <CardHeader><CardTitle className="text-sm">Search engine listing</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              <Field label="URL handle" htmlFor="p-slug" hint={`/product/${form.watch('slug') || slugify(form.watch('name') || '')}`}><Input id="p-slug" {...form.register('slug')} /></Field>
              <Field label="Page title" htmlFor="p-seo-title"><Input id="p-seo-title" {...form.register('seo_title')} /></Field>
              <Field label="Meta description" htmlFor="p-seo-desc"><Textarea id="p-seo-desc" rows={2} {...form.register('seo_description')} /></Field>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Status</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Controller control={form.control} name="status" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="ACTIVE">Active (visible)</SelectItem><SelectItem value="DRAFT">Draft</SelectItem><SelectItem value="ARCHIVED">Archived</SelectItem></SelectContent>
                </Select>
              )} />
              {[
                { name: 'is_featured' as const, label: 'Featured on home page' },
                { name: 'track_inventory' as const, label: 'Track stock' },
                { name: 'requires_production' as const, label: 'Made to order (production)' },
              ].map((s) => (
                <Controller key={s.name} control={form.control} name={s.name} render={({ field }) => (
                  <label className="flex items-center justify-between gap-2 text-sm">{s.label}<Switch checked={field.value} onCheckedChange={field.onChange} /></label>
                )} />
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm">Organisation</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Field label="Category">
                <Controller control={form.control} name="category_id" render={({ field }) => (
                  <Select value={field.value || 'none'} onValueChange={(v) => field.onChange(v === 'none' ? '' : v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="none">None</SelectItem>{(categories.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                  </Select>
                )} />
              </Field>
              <Field label="Brand" htmlFor="p-brand"><Input id="p-brand" {...form.register('brand')} /></Field>
              <Field label="Tags" htmlFor="p-tags" hint="Comma separated"><Input id="p-tags" {...form.register('tags')} /></Field>
              <Field label="Option names" htmlFor="p-options" hint="e.g. Size, Color"><Input id="p-options" {...form.register('option_names')} /></Field>
              <Field label="Weight (grams)" htmlFor="p-weight"><Input id="p-weight" type="number" min="0" {...form.register('weight_grams')} /></Field>
              <Field label="Low-stock alert at" htmlFor="p-low" hint="Leave empty to use the store default"><Input id="p-low" type="number" min="0" {...form.register('low_stock_threshold')} /></Field>
            </CardContent>
          </Card>
          {!isNew && product.data && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Margin</CardTitle></CardHeader>
              <CardContent className="text-sm">
                {toNumber(product.data.price) > 0 ? (
                  <p>{formatMoney(toNumber(product.data.price) - toNumber(product.data.cost_price))} per unit
                    <Badge variant="secondary" className="ml-2">{Math.round(((toNumber(product.data.price) - toNumber(product.data.cost_price)) / toNumber(product.data.price)) * 100)}%</Badge>
                  </p>
                ) : '—'}
              </CardContent>
            </Card>
          )}
        </div>
      </fieldset>
    </form>
  )
}

function ImagesCard({ product, canEdit }: { product: AdminProduct; canEdit: boolean }) {
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const images = [...product.product_images].sort((a, b) => a.position - b.position)
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['product-admin', product.id] })
  const upload = useMutation({
    mutationFn: async (files: FileList) => {
      let pos = images.length
      for (const file of Array.from(files)) await uploadProductImage(product.id, file, pos++, images.length === 0 && pos === 1)
    },
    onSuccess: () => { toast.success('Images uploaded'); void refresh() },
  })
  const remove = useMutation({ mutationFn: deleteProductImage, onSuccess: () => void refresh() })
  const reorder = useMutation({
    mutationFn: ({ ids, primary }: { ids: string[]; primary?: string }) => reorderProductImages(product.id, ids, primary),
    onSuccess: () => void refresh(),
  })
  const primaryId = images.find((i) => i.is_primary)?.id
  const move = (idx: number, dir: -1 | 1) => {
    const ids = images.map((i) => i.id)
    const target = idx + dir
    if (target < 0 || target >= ids.length) return
    ;[ids[idx], ids[target]] = [ids[target], ids[idx]]
    reorder.mutate({ ids, primary: primaryId })
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Images</CardTitle>
        <CardDescription>JPG, PNG or WebP up to 5 MB. The starred image is shown first.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {images.map((img, idx) => (
            <div key={img.id} className={cn('group relative overflow-hidden rounded-md border', img.is_primary && 'ring-2 ring-foreground')}>
              <img src={imageUrl(img.url, 300)} alt={img.alt ?? ''} className="aspect-square w-full object-cover" />
              {canEdit && (
                <div className="absolute inset-x-0 bottom-0 flex justify-between bg-background/90 p-1">
                  <Button type="button" size="icon-sm" variant="ghost" onClick={() => reorder.mutate({ ids: images.map((i) => i.id), primary: img.id })} aria-label="Set as main image">
                    <Star className={img.is_primary ? 'fill-current' : ''} />
                  </Button>
                  <Button type="button" size="icon-sm" variant="ghost" onClick={() => move(idx, -1)} disabled={idx === 0} aria-label="Move earlier"><ArrowUp /></Button>
                  <Button type="button" size="icon-sm" variant="ghost" onClick={() => move(idx, 1)} disabled={idx === images.length - 1} aria-label="Move later"><ArrowDown /></Button>
                  <Button type="button" size="icon-sm" variant="ghost" onClick={() => remove.mutate(img)} aria-label="Delete image"><Trash2 /></Button>
                </div>
              )}
            </div>
          ))}
          {canEdit && (
            <button type="button" onClick={() => input.current?.click()} disabled={upload.isPending}
              className="flex aspect-square flex-col items-center justify-center gap-1 rounded-md border border-dashed text-sm text-muted-foreground hover:bg-muted/50">
              {upload.isPending ? <Spinner /> : <ImagePlus className="size-5" />} Upload
            </button>
          )}
        </div>
        <input ref={input} type="file" accept="image/*" multiple hidden onChange={(ev) => ev.target.files?.length && upload.mutate(ev.target.files)} />
      </CardContent>
    </Card>
  )
}
