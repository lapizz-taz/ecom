import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { toast } from '@/lib/toast'
import { toUserMessage } from '@/lib/errors'
import { reportError } from '@/lib/monitoring'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => {
        const message = (error as { message?: string })?.message ?? ''
        if (/PERMISSION_DENIED|permission denied|NOT_FOUND|JWT/i.test(message)) return false
        return count < 2
      },
    },
  },
  queryCache: new QueryCache({
    onError: (error, query) => reportError(error, { query: query.queryKey.slice(0, 2).map(String) }),
  }),
  // Mutations show a toast on failure unless they handle errors themselves.
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      reportError(error, { mutation: mutation.options.mutationKey?.map(String) })
      if (mutation.options.meta?.silent) return
      toast.error(toUserMessage(error))
    },
  }),
})

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: { silent?: boolean }
  }
}
