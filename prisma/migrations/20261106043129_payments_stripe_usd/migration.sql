-- Phase 6: Stripe payments + USD platform currency.
-- Column DEFAULTS change to usd; existing rows keep their stored currency (the seed
-- re-prices the seeded rows). ADD VALUE is allowed in a transaction on Postgres >= 12
-- (the new value is not used in this migration).

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'REFUND_PENDING';

-- DropIndex
DROP INDEX "payments_status_idx";

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "checkoutUrl" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "paidAmount" DECIMAL(10,2),
ADD COLUMN     "paidCurrency" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3),
ADD COLUMN     "requiresReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewReason" TEXT,
ADD COLUMN     "stripeRefundId" TEXT,
ALTER COLUMN "currency" SET DEFAULT 'usd';

-- AlterTable
ALTER TABLE "shipments" ALTER COLUMN "currency" SET DEFAULT 'usd';

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "paymentId" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stripe_events_paymentId_idx" ON "stripe_events"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_stripeRefundId_key" ON "payments"("stripeRefundId");

-- CreateIndex
CREATE INDEX "payments_status_createdAt_idx" ON "payments"("status", "createdAt");

-- CreateIndex
CREATE INDEX "payments_requiresReview_idx" ON "payments"("requiresReview");

