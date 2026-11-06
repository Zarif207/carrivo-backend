-- Pickup window end. Safe on a table that already has rows:
-- 1) add the column as nullable, 2) backfill existing rows with a 2-hour window,
-- 3) then enforce NOT NULL. Every step is re-runnable, so if the migration is
-- interrupted part-way, running it again finishes the job.

-- 1. Add as nullable
ALTER TABLE "pickup_requests" ADD COLUMN IF NOT EXISTS "scheduledUntil" TIMESTAMP(3);

-- 2. Backfill: window end = window start + 2 hours
UPDATE "pickup_requests"
SET "scheduledUntil" = "scheduledAt" + INTERVAL '2 hours'
WHERE "scheduledUntil" IS NULL;

-- 3. Enforce NOT NULL (matches the Prisma schema)
ALTER TABLE "pickup_requests" ALTER COLUMN "scheduledUntil" SET NOT NULL;
