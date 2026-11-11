-- Courier applications: a CUSTOMER applies to become a COURIER; an ADMIN approves or rejects.
-- Additive only: two new enums, three new NotificationType values, one new table. No existing
-- row is changed. (Adding several enum values in one migration needs PostgreSQL 12+.)

-- CreateEnum
CREATE TYPE "CourierApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkAvailability" AS ENUM ('WEEKDAYS', 'WEEKENDS', 'FULL_TIME');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'COURIER_APPLICATION_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'COURIER_APPLICATION_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'COURIER_APPLICATION_REJECTED';

-- CreateTable
CREATE TABLE "courier_applications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "CourierApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "phone" TEXT NOT NULL,
    "preferredZoneId" TEXT,
    "vehicleType" "VehicleType" NOT NULL,
    "vehiclePlate" TEXT,
    "availability" "WorkAvailability" NOT NULL,
    "experience" TEXT,
    "about" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courier_applications_pkey" PRIMARY KEY ("id"),
    -- Business rules the API also enforces (Zod + service); the database is the last line.
    CONSTRAINT "courier_applications_decision_reviewed_check"
        CHECK ("status" NOT IN ('APPROVED', 'REJECTED') OR ("reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL)),
    CONSTRAINT "courier_applications_reject_note_check"
        CHECK ("status" <> 'REJECTED' OR length(btrim(coalesce("reviewNote", ''))) > 0),
    CONSTRAINT "courier_applications_text_length_check"
        CHECK (
            char_length("phone") <= 30
            AND ("vehiclePlate" IS NULL OR char_length("vehiclePlate") <= 20)
            AND ("experience" IS NULL OR char_length("experience") <= 500)
            AND ("about" IS NULL OR char_length("about") <= 1000)
            AND ("reviewNote" IS NULL OR char_length("reviewNote") <= 500)
        )
);

-- CreateIndex
CREATE INDEX "courier_applications_status_createdAt_idx" ON "courier_applications"("status", "createdAt");

-- CreateIndex
CREATE INDEX "courier_applications_userId_idx" ON "courier_applications"("userId");

-- CreateIndex
CREATE INDEX "courier_applications_preferredZoneId_idx" ON "courier_applications"("preferredZoneId");

-- At most ONE pending application per user, even under concurrent submits. A partial index can't be
-- declared in schema.prisma; Prisma ignores it (migrate diff stays empty), so it is kept here.
CREATE UNIQUE INDEX "courier_applications_one_pending_per_user"
    ON "courier_applications"("userId") WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "courier_applications" ADD CONSTRAINT "courier_applications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_applications" ADD CONSTRAINT "courier_applications_preferredZoneId_fkey" FOREIGN KEY ("preferredZoneId") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_applications" ADD CONSTRAINT "courier_applications_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
