import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const alias = { '@': resolve(__dirname, 'src') }

// Database integration tests need a disposable PostgreSQL server; they run
// only when TEST_DATABASE_URL is set (see supabase/tests/README.md).
const withDb = Boolean(process.env.TEST_DATABASE_URL)

// The same suite against the Cloudflare database (worker/db): `CF_DB_TESTS=1`.
// Imports of the Postgres test helpers are redirected to worker/db/pgshim/db.ts.
const withCfDb = Boolean(process.env.CF_DB_TESTS)
const pgshim = resolve(__dirname, 'worker/db/pgshim/db.ts')
const redirectDb = {
  name: 'cfdb-redirect',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string) {
    if (importer?.includes('/supabase/tests/') && /(^|\/)(support\/)?db(\.ts)?$/.test(source) && (source.includes('support/db') || source === './db')) return pgshim
    return null
  },
}

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'supabase/functions/**/*.test.ts', 'worker/**/*.test.ts', 'pbx-gateway/controller/src/**/*.test.ts'],
        },
      },
      ...(withDb
        ? [
            {
              test: {
                name: 'db',
                environment: 'node',
                include: ['supabase/tests/db/**/*.test.ts'],
                globalSetup: ['supabase/tests/support/global-setup.ts'],
                fileParallelism: false,
                testTimeout: 30_000,
                hookTimeout: 120_000,
              },
            },
          ]
        : []),
      ...(withCfDb
        ? [
            {
              plugins: [redirectDb],
              test: {
                name: 'cfdb',
                environment: 'node',
                include: ['supabase/tests/db/**/*.test.ts'],
                testTimeout: 30_000,
              },
            },
          ]
        : []),
    ],
  },
})
