import { QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { RouterProvider } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthProvider } from '@/features/auth/auth-context'
import { env } from '@/lib/env'
import { queryClient } from '@/lib/query-client'
import { createAppRouter } from '@/routes/router'

function MissingConfig() {
  return (
    <div className="mx-auto max-w-lg p-8 text-sm">
      <h1 className="mb-2 text-lg font-semibold">Supabase is not configured</h1>
      <p className="text-muted-foreground">
        Copy <code>.env.example</code> to <code>.env.local</code> and set <code>VITE_SUPABASE_URL</code> and{' '}
        <code>VITE_SUPABASE_ANON_KEY</code>, then restart the dev server.
      </p>
    </div>
  )
}

export default function App() {
  // Built once, after main.tsx knows what this address shows.
  const [router] = useState(() => (env.isConfigured ? createAppRouter() : null))
  if (!env.isConfigured || !router) return <MissingConfig />
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster position="top-right" />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  )
}
