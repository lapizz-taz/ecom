import { Hammer } from 'lucide-react'
import { useMatches } from 'react-router'
import { EmptyState } from '@/components/common/states'
import { PLATFORM_NAV } from '@/features/platform/nav'

/** Temporary page for a section that is not built yet. */
export default function NotBuiltPage() {
  const module = [...useMatches()].reverse().map((m) => (m.handle as { module?: string } | undefined)?.module).find(Boolean)
  const item = PLATFORM_NAV.find((n) => n.module === module)
  return <EmptyState icon={<Hammer />} title={`${item?.label ?? 'This section'} is not built yet`} description="Nothing here works yet, so nothing is shown." />
}
