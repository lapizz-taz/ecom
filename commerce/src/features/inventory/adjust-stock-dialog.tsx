import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Field } from '@/components/common/field'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { VariantPicker } from '@/features/products/variant-picker'
import { adjustStock } from '@/services/inventory'

export interface AdjustTarget {
  variantId: string
  label: string
  onHand?: number | null
  available?: number | null
  damaged?: number | null
}

const ACTIONS = [
  { value: 'ADD', type: 'ADJUSTMENT', mode: 'ADD', label: 'Add stock (correction)' },
  { value: 'REMOVE', type: 'ADJUSTMENT', mode: 'REMOVE', label: 'Remove stock (correction)' },
  { value: 'SET', type: 'ADJUSTMENT', mode: 'SET', label: 'Set to counted quantity' },
  { value: 'PURCHASE', type: 'PURCHASE', mode: 'ADD', label: 'Received stock (no purchase order)' },
  { value: 'DAMAGE', type: 'DAMAGE', mode: 'ADD', label: 'Mark damaged' },
  { value: 'LOSS', type: 'LOSS', mode: 'ADD', label: 'Lost / stolen' },
  { value: 'TRANSFER', type: 'TRANSFER', mode: 'ADD', label: 'Repaired: damaged → sellable' },
] as const

/** Every stock change creates an inventory movement with a reason. */
export function AdjustStockDialog({ target, open, onOpenChange }: { target: AdjustTarget | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient()
  const [picked, setPicked] = useState<AdjustTarget | null>(null)
  const [action, setAction] = useState<(typeof ACTIONS)[number]['value']>('ADD')
  const [quantity, setQuantity] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [note, setNote] = useState('')
  const current = target ?? picked
  const spec = ACTIONS.find((a) => a.value === action)!

  const save = useMutation({
    mutationFn: () => adjustStock({
      variantId: current!.variantId, type: spec.type, mode: spec.mode, quantity: Number(quantity), note,
      unitCost: action === 'PURCHASE' && unitCost ? Number(unitCost) : null,
    }),
    onSuccess: (mov) => {
      toast.success(`Stock updated — on hand now ${mov?.on_hand_after}`)
      void queryClient.invalidateQueries({ queryKey: ['inventory'] })
      void queryClient.invalidateQueries({ queryKey: ['product-admin'] })
      setQuantity(''); setNote(''); setUnitCost(''); setPicked(null)
      onOpenChange(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust stock</DialogTitle>
          <DialogDescription>{current ? <>{current.label}{current.onHand != null && <> · on hand {current.onHand}, available {current.available}, damaged {current.damaged ?? 0}</>}</> : 'Choose a product variant.'}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
          {!target && (
            <VariantPicker onPick={(v) => setPicked({ variantId: v.variant_id!, label: `${v.product_name}${v.variant_title && v.variant_title !== 'Default' ? ` · ${v.variant_title}` : ''} (${v.sku})`, available: v.available })} />
          )}
          <Field label="What happened?">
            <Select value={action} onValueChange={(v) => setAction(v as typeof action)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{ACTIONS.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={action === 'SET' ? 'Counted quantity' : 'Quantity'} htmlFor="adj-qty"><Input id="adj-qty" type="number" min={0} value={quantity} onChange={(e) => setQuantity(e.target.value)} /></Field>
            {action === 'PURCHASE' && <Field label="Unit cost (optional)" htmlFor="adj-cost"><Input id="adj-cost" type="number" min={0} value={unitCost} onChange={(e) => setUnitCost(e.target.value)} /></Field>}
          </div>
          <Field label="Reason" htmlFor="adj-note" required><Textarea id="adj-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Monthly stock count" /></Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!current || quantity === '' || !note.trim() || save.isPending}>{save.isPending && <Spinner />} Save adjustment</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
