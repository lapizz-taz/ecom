-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "platformOrderId" TEXT;

-- CreateTable
CREATE TABLE "OrderForward" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "responseCode" INTEGER,
    "error" TEXT,
    "externalId" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderForward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderForward_status_nextAttemptAt_idx" ON "OrderForward"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderForward_orderId_event_key" ON "OrderForward"("orderId", "event");

-- AddForeignKey
ALTER TABLE "OrderForward" ADD CONSTRAINT "OrderForward_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Same defence in depth as 20260930220000_lock_down_tables: no Data API access on Supabase.
ALTER TABLE "OrderForward" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE "OrderForward" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE "OrderForward" FROM authenticated';
  END IF;
END $$;
