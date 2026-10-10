import { ArrowRight, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/common/page-header'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RELEASES, type ReleaseTag } from '@/features/support/releases'
import { formatDate } from '@/lib/format'

const TAG: Record<ReleaseTag, 'success' | 'info' | 'warning'> = { New: 'success', Improved: 'info', Fixed: 'warning' }

export default function UpdatesPage() {
  const [tag, setTag] = useState<'all' | ReleaseTag>('all')
  const [q, setQ] = useState('')
  // Opening this page counts as reading the updates (same as the ✨ menu).
  useEffect(() => {
    try { if (RELEASES[0]) localStorage.setItem('admin-whats-new-seen', RELEASES[0].date) } catch { /* private mode */ }
  }, [])
  const shown = useMemo(() => RELEASES.filter((r) => (tag === 'all' || r.tag === tag)
    && (!q || `${r.title} ${r.body} ${r.area}`.toLowerCase().includes(q.toLowerCase()))), [tag, q])
  const byDate = [...new Set(shown.map((r) => r.date))]

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Updates" description="What's new and what we fixed, newest first." />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={tag} onValueChange={(v) => setTag(v as typeof tag)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="New">New</TabsTrigger>
            <TabsTrigger value="Improved">Improved</TabsTrigger>
            <TabsTrigger value="Fixed">Fixed</TabsTrigger>
          </TabsList>
        </Tabs>
        <SearchInput value={q} onChange={setQ} placeholder="Search updates" className="w-full sm:w-60" />
      </div>
      {!shown.length ? <EmptyState icon={<Sparkles />} title="No updates match" /> : (
        <ol className="relative space-y-6 border-l pl-6">
          {byDate.map((d) => (
            <li key={d} className="space-y-3">
              <span className="absolute -left-[5px] mt-1.5 size-2.5 rounded-full bg-brand" aria-hidden />
              <p className="text-sm font-medium text-muted-foreground">{formatDate(d)}</p>
              {shown.filter((r) => r.date === d).map((r) => (
                <Card key={r.title} className="gap-1.5 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={TAG[r.tag]}>{r.tag}</Badge>
                    <span className="text-xs text-muted-foreground">{r.area}</span>
                  </div>
                  <p className="font-medium">{r.title}</p>
                  <p className="text-sm text-muted-foreground">{r.body}</p>
                  {r.to && <Link to={r.to} className="inline-flex w-fit items-center gap-1 text-sm font-medium text-brand hover:underline">Open <ArrowRight className="size-3.5" /></Link>}
                </Card>
              ))}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
