import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, Store, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth/auth-context'
import { useDebounce } from '@/hooks/use-debounce'
import { useStoreAddress } from '@/hooks/use-store-address'
import { useStoreConfig } from '@/hooks/use-store-config'
import { toUserMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { checkStoreSlug, suggestStoreSlug } from '@/services/onboarding'
import { answerOnlineStore, storePublicUrl } from '@/services/website'

const SLUG = /^[a-z0-9]([a-z0-9]|-(?!-)){1,40}$/

/**
 * Dashboard: "Do you want a Fullfilio online store?" for a business that has
 * not answered yet. Yes opens the store under the address chosen here; no
 * publishes nothing. Either can be changed later under Sales channels.
 */
export function OnlineStoreChoice() {
  const { can } = useAuth()
  const address = useStoreAddress()
  const { data: config } = useStoreConfig()
  const queryClient = useQueryClient()
  // "No, I sell elsewhere" (Shopify, WooCommerce, social) is the default answer.
  const [open, setOpen] = useState<boolean | null>(false)
  const [slug, setSlug] = useState('')
  const [edited, setEdited] = useState(false)
  const show = can('settings.manage') && address.data && !address.data.asked

  // Suggest an address from the business name until the owner types their own.
  const name = config?.store.name?.trim() ?? ''
  useEffect(() => {
    if (!show || open !== true || edited || name.length < 2) return
    let live = true
    void suggestStoreSlug(name).then((s) => { if (live) setSlug(s) }).catch(() => {})
    return () => { live = false }
  }, [show, open, edited, name])

  const typed = useDebounce(slug, 350)
  const check = useQuery({ queryKey: ['store-slug', typed], enabled: !!show && open === true && SLUG.test(typed), queryFn: () => checkStoreSlug(typed), staleTime: 30_000 })
  const root = check.data?.root_domain
  const problem = slug && !SLUG.test(slug) ? 'Use 2 to 41 lower-case letters, numbers and single dashes'
    : check.data && !check.data.available && check.data.slug === slug ? check.data.reason : null

  const save = useMutation({
    mutationFn: () => answerOnlineStore(open === true, open ? slug : undefined),
    onSuccess: (a) => {
      queryClient.setQueryData(['store-address'], a)
      toast.success(a.mode === 'OWN' ? `Your store is open at ${storePublicUrl(a)?.replace(/^https?:\/\//, '')}` : 'Saved. No online store is published.')
    },
    onError: (e) => toast.error(toUserMessage(e)),
  })

  if (!show) return null
  const option = (on: boolean, icon: React.ReactNode, title: string, text: string) => (
    <button type="button" role="radio" aria-checked={open === on} onClick={() => setOpen(on)}
      className={cn('flex items-start gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:border-foreground/20',
        open === on && 'border-brand ring-1 ring-brand hover:border-brand')}>
      <span className={cn('grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground', open === on && 'bg-brand-soft text-brand')}>{icon}</span>
      <span><span className="block text-[13px] font-medium">{title}</span><span className="block text-xs text-muted-foreground">{text}</span></span>
    </button>
  )
  const ready = open === false || (open === true && SLUG.test(slug) && !problem && !check.isFetching)

  return (
    <section aria-label="Online store" className="rounded-xl border bg-card p-4">
      <h2 className="text-[13px] font-semibold">Do you want a Fullfilio online store?</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">Choose once; you can change it later under Sales channels.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup">
        {option(true, <Store className="size-3.5" />, 'Yes, open my online store', 'A ready store with checkout, courier booking and its own address.')}
        {option(false, <Unplug className="size-3.5" />, 'No, I sell elsewhere', 'Facebook, Shopify or WooCommerce only. No store address is created.')}
      </div>
      {open === true && (
        <div className="mt-2 grid gap-1.5 rounded-lg border bg-muted/30 p-3">
          <span className="text-[11px] font-medium text-muted-foreground">Your store address</span>
          <div className={cn('flex h-9 items-center overflow-hidden rounded-lg border bg-card text-[13px] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/15', problem && 'border-destructive')}>
            {!root && <span className="shrink-0 pl-3 text-muted-foreground">{window.location.host}/s/</span>}
            <input value={slug} aria-label="Store address" spellCheck={false} autoCapitalize="none" maxLength={41}
              onChange={(e) => { setEdited(true); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')) }}
              className={cn('h-full min-w-0 flex-1 bg-transparent font-medium outline-none', root ? 'pl-3' : 'pl-0.5')} placeholder="your-shop" />
            {root && <span className="shrink-0 pr-3 text-muted-foreground">.{root}</span>}
            <span className="grid w-9 shrink-0 place-items-center">
              {check.isFetching ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                : check.data?.available && check.data.slug === slug ? <Check className="size-3.5 text-emerald-600" /> : null}
            </span>
          </div>
          {problem ? <p className="text-xs text-destructive">{problem}</p>
            : <p className="text-xs text-muted-foreground">You can connect your own domain later in Store → Website.</p>}
        </div>
      )}
      {open !== null && (
        <div className="mt-3 flex justify-end">
          <Button size="sm" disabled={!ready || save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="animate-spin" />} {open ? 'Open my store' : 'Save'}
          </Button>
        </div>
      )}
    </section>
  )
}
