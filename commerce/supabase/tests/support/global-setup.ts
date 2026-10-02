import { createTestDatabase } from './db'

// Creates a fresh database with every migration applied before the DB suite.
export default async function setup(): Promise<void> {
  const url = await createTestDatabase('commerce_test')
  process.env.COMMERCE_TEST_DB_URL = url
}
