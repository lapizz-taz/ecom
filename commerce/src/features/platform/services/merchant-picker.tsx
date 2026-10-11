import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { listMerchants, type MerchantRef } from '@/services/platform'

/** Find one merchant by name or number (only merchants the employee may work with are listed). */
export function MerchantPicker({ value, onChange }: { value: MerchantRef | null; onChange: (m: MerchantRef | null) => void }) {
  const [q, setQ] = useState('')
  const list = useQuery({
    queryKey: ['platform-merchants', 'picker', q], enabled: !value,
    queryFn: () => listMerchants(q ? { q } : {}, 'number', 'asc', 1, 20),
  })
  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
        <span>#{value.number} {value.name}</span>
        <button type="button" className="text-xs text-muted-foreground underline" onClick={() => onChange(null)}>Change</button>
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <Input aria-label="Find a merchant" placeholder="Name or number" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="max-h-44 overflow-y-auto rounded-md border">
        {(list.data?.items ?? []).map((m) => (
          <button key={m.id} type="button" onClick={() => onChange({ id: m.id, number: m.number, name: m.name })}
            className={cn('flex w-full justify-between px-3 py-1.5 text-left text-sm hover:bg-muted/50')}>
            <span>#{m.number} {m.name}</span><span className="text-xs text-muted-foreground">{m.status.toLowerCase()}</span>
          </button>
        ))}
        {list.data && list.data.items.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No merchant found</p>}
      </div>
    </div>
  )
}
