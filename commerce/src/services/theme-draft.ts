import { supabase } from '@/lib/supabase'

// The store builder's saved draft and Publish (storefront_draft_* / storefront_publish): the
// live store changes only when a draft is published.

/** What the editor owns in the storefront setting. */
export interface ThemeContent {
  theme?: Record<string, unknown>
  footer_text?: string | null
}

export interface ThemeDraftState {
  live: ThemeContent
  draft: ThemeContent | null
  draft_saved_at: string | null
  draft_saved_by: string | null
  published_at: string | null
  published_by: string | null
}

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn as never, args as never)
  if (error) throw error
  return data as unknown as T
}

export const getThemeDraft = () => call<ThemeDraftState>('storefront_draft_get')
/** Saves the draft; base is when the draft the editor started from was saved (null: none then). */
export const saveThemeDraft = (content: ThemeContent, base: string | null) =>
  call<{ draft_saved_at: string }>('storefront_draft_save', { p_content: content, p_base: base })
export const publishTheme = (base: string | null) => call<{ published_at: string }>('storefront_publish', { p_base: base })
export const discardThemeDraft = () => call<void>('storefront_draft_discard')
