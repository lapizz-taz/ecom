import { useQuery } from '@tanstack/react-query'
import { Eye } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime } from '@/lib/format'
import { supportAccessLog } from '@/services/support-center'

/** Who from the platform's support team looked at this business, when and why (read-only views). */
export function SupportAccessCard() {
  const q = useQuery({ queryKey: ['support-access-log'], queryFn: supportAccessLog })
  if (!q.data) return null
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Eye className="size-4" /> Platform support access</CardTitle></CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        {q.data.length === 0 ? <p className="text-muted-foreground">Nobody from the support team has viewed your account.</p> : q.data.slice(0, 10).map((s) => (
          <div key={s.id} className="flex flex-wrap items-baseline gap-x-2 border-b pb-1.5 last:border-0">
            <span className="font-medium">{s.staff}</span>
            <span className="text-xs text-muted-foreground">{formatDateTime(s.started_at)} – {s.active ? 'now' : formatDateTime(s.ended_at)}</span>
            {s.active && <Badge variant="warning">Viewing now</Badge>}
            {s.ticket_number && <span className="text-xs text-muted-foreground">ticket #{s.ticket_number}</span>}
            <p className="w-full text-xs text-muted-foreground">{s.reason}</p>
          </div>
        ))}
        <p className="pt-1 text-xs text-muted-foreground">These views are read-only and time-limited: the support team can look, but cannot change anything or see passwords.</p>
      </CardContent>
    </Card>
  )
}
