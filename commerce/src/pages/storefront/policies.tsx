import { NavLink, useParams } from 'react-router'
import { LoadingState } from '@/components/common/states'
import { useStoreConfig } from '@/hooks/use-store-config'
import { titleCase } from '@/lib/format'
import { cn } from '@/lib/utils'

const ORDER = ['shipping', 'returns', 'privacy', 'terms']

export default function PoliciesPage() {
  const { policy } = useParams()
  const { data: config, isLoading } = useStoreConfig()
  if (isLoading) return <LoadingState />
  const policies = config?.policies ?? {}
  const keys = [...ORDER.filter((k) => policies[k]), ...Object.keys(policies).filter((k) => !ORDER.includes(k))]
  const active = policy && policies[policy] ? policy : keys[0]
  return (
    <div className="mx-auto grid max-w-4xl gap-8 px-4 py-10 md:grid-cols-[180px_1fr]">
      <nav className="flex gap-1 overflow-x-auto md:flex-col">
        {keys.map((k) => (
          <NavLink key={k} to={`/policies/${k}`} className={cn('rounded-md px-3 py-2 text-sm whitespace-nowrap hover:bg-accent', k === active && 'bg-accent font-medium')}>
            {titleCase(k)} policy
          </NavLink>
        ))}
      </nav>
      <article>
        <h1 className="mb-4 text-2xl font-semibold">{titleCase(active)} policy</h1>
        <div className="space-y-3 leading-relaxed whitespace-pre-line text-muted-foreground">{active ? policies[active] : 'No policies published yet.'}</div>
      </article>
    </div>
  )
}
