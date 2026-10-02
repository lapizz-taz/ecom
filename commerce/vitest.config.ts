import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const alias = { '@': resolve(__dirname, 'src') }

// Database integration tests need a disposable PostgreSQL server; they run
// only when TEST_DATABASE_URL is set (see supabase/tests/README.md).
const withDb = Boolean(process.env.TEST_DATABASE_URL)

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'supabase/functions/**/*.test.ts'],
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
    ],
  },
})
