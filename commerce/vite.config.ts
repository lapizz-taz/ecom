import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

/** The commit being built (Cloudflare Workers Builds and Vercel name it; else git), short. */
function commit(): string {
  const named = process.env.WORKERS_CI_COMMIT_SHA || process.env.CF_PAGES_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA
  if (named) return named.slice(0, 7)
  try { return execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return '' }
}

// This build's version: when it was made (minute, UTC) and from which commit, e.g. "2026-11-10T06:30Z+abc1234".
// Errors carry it, so the Super Admin error tracker can tell a tab not reloaded since a fix from the fix failing.
const sha = commit()
const release = `${new Date().toISOString().slice(0, 16)}Z${sha ? `+${sha}` : ''}`

export default defineConfig(({ mode, isSsrBuild }) => ({
  plugins: [react(), tailwindcss()],
  define: { __APP_RELEASE__: JSON.stringify(release) },
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    // Same as the Worker's (and vercel.json's) route: Shopify's OAuth callback on the app's own host.
    proxy: {
      '/oauth/shopify/callback': {
        target: loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_URL || 'http://127.0.0.1:54321',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/oauth\/shopify\/callback/, '/functions/v1/channels/callback/shopify'),
      },
    },
  },
  // The server build is the website's pages as HTML (src/site-prerender.tsx), run once by
  // scripts/prerender-site.mjs: no public files, no browser chunks.
  build: isSsrBuild ? { copyPublicDir: false, outDir: 'dist-ssr', emptyOutDir: true } : {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router'],
          supabase: ['@supabase/supabase-js'],
          charts: ['recharts'],
          forms: ['react-hook-form', '@hookform/resolvers', 'zod'],
        },
      },
    },
  },
}))
