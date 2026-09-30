// Test environment — never uses real credentials.
(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://isolation:isolation@localhost:5432/isolation_test";
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET = "test-secret-test-secret-test-secret-123";
process.env.META_APP_SECRET = "test-meta-app-secret";
process.env.META_VERIFY_TOKEN = "test-verify-token";
process.env.META_ACCESS_TOKEN = "";
process.env.META_APP_ID = "999";
process.env.WHATSAPP_VERIFY_TOKEN = "test-wa-verify";
process.env.OPENAI_API_KEY = "";
process.env.SHOPIFY_STORE_DOMAIN = "";
process.env.SHOPIFY_ACCESS_TOKEN = "";
