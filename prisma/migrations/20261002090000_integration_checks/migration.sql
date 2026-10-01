-- CreateTable
CREATE TABLE "IntegrationCheck" (
    "service" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "message" TEXT NOT NULL,
    "notes" JSONB,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedBy" TEXT,

    CONSTRAINT "IntegrationCheck_pkey" PRIMARY KEY ("service")
);

-- Same defence in depth as 20260930220000_lock_down_tables: no Data API access on Supabase.
ALTER TABLE "IntegrationCheck" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "IntegrationCheck" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE "IntegrationCheck" FROM authenticated';
  END IF;
END $$;
