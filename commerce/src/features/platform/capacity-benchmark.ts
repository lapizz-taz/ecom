// What the order system sustained in the last load test (scripts/load-test.mjs). Filled in
// from that run's output; shown on Super Admin → Live & Capacity next to today's real traffic.
export interface CapacityBenchmark {
  /** When and where it was measured. */
  measuredAt: string
  environment: string
  /** Storefront orders placed per second, end to end in the database (stock reserved, numbered, customer saved). */
  ordersPerSecond: number
  /** Order status changes per second (with stock, history and money side effects). */
  statusChangesPerSecond: number
  /** Order search answer time at that load (95th percentile, ms). */
  searchP95Ms: number
  /** Parallel clients used. */
  concurrency: number
  /** Orders in the database during the run. */
  ordersInDatabase: number
  errors: number
}

// scripts/load-test.mjs, docs/load-test-results.json: a fresh database built from every migration,
// 16 clients at once on one 4-core machine that also ran the load generator. Production runs on
// Supabase's own database server, so treat these as a floor for what one store's database does.
export const CAPACITY_BENCHMARK: CapacityBenchmark | null = {
  measuredAt: '2026-10-12',
  environment: 'local PostgreSQL 16, 4 CPU cores, load generator on the same machine',
  ordersPerSecond: 134,
  statusChangesPerSecond: 561,
  searchP95Ms: 25,
  concurrency: 16,
  ordersInDatabase: 3926,
  errors: 0,
}
