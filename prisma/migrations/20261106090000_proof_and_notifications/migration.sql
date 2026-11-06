-- Phase 7: proof-of-delivery columns + notifications.
-- Additive only: two nullable columns, two new enums, one new table. No existing
-- data is rewritten, so it is safe to apply to a database with live rows.
-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('SHIPMENT_CREATED', 'COURIER_ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_DELIVERY', 'PAYMENT_RECEIVED', 'REFUND_COMPLETED');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "proofOfDeliveryPublicId" TEXT,
ADD COLUMN     "proofOfDeliveryUploadedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shipmentId" TEXT,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "emailStatus" "EmailStatus" NOT NULL DEFAULT 'PENDING',
    "emailError" TEXT,
    "emailSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_shipmentId_idx" ON "notifications"("shipmentId");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

