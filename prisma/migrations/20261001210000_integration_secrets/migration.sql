-- CreateTable
CREATE TABLE "IntegrationSecret" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "IntegrationSecret_pkey" PRIMARY KEY ("key")
);

-- Same defence in depth as 20260930220000_lock_down_tables: no Data API access on Supabase.
ALTER TABLE "IntegrationSecret" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "IntegrationSecret" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE "IntegrationSecret" FROM authenticated';
  END IF;
END $$;
