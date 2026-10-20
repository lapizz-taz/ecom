import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, useEffect } from 'react'
import { useAuth } from '@/features/auth/auth-context'
import type { Storefront } from '@/features/storefront/theme'
import { useStoreConfig } from '@/hooks/use-store-config'
import { toast } from '@/lib/toast'
import { discardThemeDraft, getThemeDraft, publishTheme, saveThemeDraft, type ThemeContent } from '@/services/theme-draft'

const pick = (v: Record<string, unknown>): ThemeContent => ({
  theme: (v.theme ?? {}) as Record<string, unknown>,
  ...(v.footer_text !== undefined ? { footer_text: (v.footer_text as string | null) ?? null } : {}),
})
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * The theme editor's work: Save keeps it as a draft (the live store does not change), Publish
 * puts it live. The editor reads the store's live settings with its own content on top.
 */
export function useThemeDraft() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const { data: config } = useStoreConfig()
  const query = useQuery({ queryKey: ['theme-draft'], queryFn: getThemeDraft, refetchOnWindowFocus: false })
  const server = query.data
  // What the server holds for the editor: the saved draft, else the live theme.
  const saved = server ? pick((server.draft ?? server.live) as Record<string, unknown>) : undefined
  const [content, setContent] = useState<ThemeContent | undefined>()
  // When the draft this editor builds on was saved (sent back so a newer one is never overwritten).
  const base = useRef<string | null>(null)
  useEffect(() => {
    if (server && content === undefined) {
      setContent(structuredClone(saved))
      base.current = server.draft_saved_at
    }
  }, [server, content, saved])

  const dirty = !!content && !!saved && !same(content, saved)
  const unpublished = !!server?.draft && !same(pick(server.draft as Record<string, unknown>), pick(server.live as Record<string, unknown>))
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['theme-draft'] }),
    queryClient.invalidateQueries({ queryKey: ['store-config'] }),
    queryClient.invalidateQueries({ queryKey: ['storefront-seo'] }),
  ])

  const save = useMutation({
    mutationFn: async () => {
      const r = await saveThemeDraft(content!, base.current)
      base.current = r.draft_saved_at
      return r
    },
    onSuccess: async () => { await refresh(); toast.success('Draft saved. Publish to show it on your store.') },
    onError: (e) => toast.error(e),
  })
  const publish = useMutation({
    mutationFn: async () => {
      if (dirty || !server?.draft) {
        const r = await saveThemeDraft(content!, base.current)
        base.current = r.draft_saved_at
      }
      await publishTheme(base.current)
      base.current = null
    },
    onSuccess: async () => { await refresh(); toast.success('Published. Your store shows these changes now.') },
    onError: (e) => toast.error(e),
  })
  const discardDraft = useMutation({
    mutationFn: discardThemeDraft,
    onSuccess: async () => {
      base.current = null
      if (server) setContent(structuredClone(pick(server.live as Record<string, unknown>)))
      await refresh()
      toast.success('Draft discarded. The editor shows your live store again.')
    },
    onError: (e) => toast.error(e),
  })

  // The whole storefront setting as the store would read it: live keys, the editor's content over them.
  const draft = useMemo(() => (content ? ({ ...(config?.storefront ?? {}), ...content } as Storefront) : undefined), [config?.storefront, content])

  return {
    query,
    draft,
    dirty,
    unpublished,
    hasDraft: !!server?.draft,
    save,
    publish,
    discardDraft,
    canEdit: can('settings.manage'),
    savedAt: server?.draft_saved_at ?? null,
    savedBy: server?.draft_saved_by ?? null,
    publishedAt: server?.published_at ?? null,
    /** Back to what is saved (the draft, or the live theme). */
    reset: () => { if (saved) setContent(structuredClone(saved)) },
    /** Replaces the editor's content (undo / redo / any edit). */
    replace: (next: Record<string, unknown>) => setContent(pick(next)),
  }
}
