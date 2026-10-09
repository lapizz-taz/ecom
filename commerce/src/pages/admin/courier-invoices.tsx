import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, FileSpreadsheet, ScanSearch, TrendingDown, TrendingUp } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth/auth-context'
import { CourierStatements, UploadStatementDialog } from '@/features/couriers/courier-statements'
import { useUrlState } from '@/hooks/use-url-state'
import { formatMoney, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { courierInvoiceSummary } from '@/services/couriers'

/**
 * Courier invoice upload: drop the courier's payment invoice and see straight
 * away whether they paid you correctly — parcel by parcel against your records.
 */
export default function CourierInvoicesPage() {
  const { can } = useAuth()
  const [, update] = useUrlState({ statement: '' })
  const summary = useQuery({ queryKey: ['courier-invoices', 'summary'], queryFn: courierInvoiceSummary })
  const [file, setFile] = useState<File | null>(null)
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const s = summary.data
  const manage = can('couriers.manage')

  return (
    <div className="space-y-4">
      <PageHeader title="Courier invoice upload" description="Upload the courier's payment invoice. Every parcel is checked against your orders, so you know if they paid you right."
        actions={<Button size="sm" variant="outline" asChild><Link to="/admin/courier-management">Courier management</Link></Button>} />

      {manage && (
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) setFile(f) }}
          onClick={() => input.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && input.current?.click()}
          className={cn('flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-all duration-300',
            over ? 'scale-[1.01] border-foreground bg-muted/60' : 'hover:border-foreground/40 hover:bg-muted/30')}>
          <span className={cn('grid size-12 place-items-center rounded-full border transition-transform duration-300', over && 'scale-110')}><FileSpreadsheet className="size-5" /></span>
          <p className="font-medium">Drop the courier invoice here</p>
          <p className="max-w-md text-sm text-muted-foreground">CSV or Excel from Pathao, Steadfast, RedX or any courier. We read the consignment IDs, match your parcels and compare cash collected and every fee.</p>
          <Button size="sm" className="mt-1" onClick={(e) => { e.stopPropagation(); input.current?.click() }}>Choose file</Button>
          <input ref={input} type="file" hidden accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = '' }} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Invoices checked" icon={<ScanSearch />} value={s ? formatNumber(s.statements) : '—'} hint={s ? `${formatMoney(s.received)} reported paid` : undefined} />
        <StatCard label="Paid correctly" icon={<CheckCircle2 />} value={s ? formatNumber(s.correct) : '—'} hint={s?.flagged ? `${s.flagged} parcels flagged in total` : 'Every parcel matched'} />
        <StatCard label="Courier paid short" icon={<TrendingDown />} value={s ? formatMoney(s.short) : '—'} hint={s ? `${s.shortCount} invoice${s.shortCount === 1 ? '' : 's'}` : undefined} />
        <StatCard label="Courier paid over" icon={<TrendingUp />} value={s ? formatMoney(s.over) : '—'} hint={s ? `${s.overCount} invoice${s.overCount === 1 ? '' : 's'}` : undefined} />
      </div>

      <CourierStatements hideUpload />

      {file && (
        <UploadStatementDialog initialFile={file} onClose={() => setFile(null)}
          onImported={(id) => { setFile(null); void summary.refetch(); update({ statement: id }, { resetPage: false }) }} />
      )}
    </div>
  )
}
