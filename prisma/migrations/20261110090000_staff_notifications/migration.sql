-- Staff (ADMIN + ADMIN_VIEWER) notifications: new event types, a frontend link per row,
-- and a per-recipient idempotency key. Additive only: existing rows keep link/dedupeKey NULL.
-- (Adding several enum values in one migration needs PostgreSQL 12+.)

ALTER TYPE "NotificationType" ADD VALUE 'SHIPMENT_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_FAILED';
ALTER TYPE "NotificationType" ADD VALUE 'REFUND_FAILED';
ALTER TYPE "NotificationType" ADD VALUE 'ZONE_CHANGED';
ALTER TYPE "NotificationType" ADD VALUE 'HUB_CHANGED';
ALTER TYPE "NotificationType" ADD VALUE 'COURIER_ADDED';

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "link" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupeKey_key" ON "notifications"("dedupeKey");

