-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CUSTOMER', 'COURIER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'PICKUP_SCHEDULED', 'COURIER_ASSIGNED', 'PICKED_UP', 'AT_ORIGIN_HUB', 'IN_TRANSIT', 'AT_DESTINATION_HUB', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_DELIVERY', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShipmentPaymentStatus" AS ENUM ('UNPAID', 'PAID', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('STANDARD', 'EXPRESS', 'SAME_DAY');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('BICYCLE', 'MOTORCYCLE', 'CAR', 'VAN', 'TRUCK');

-- CreateEnum
CREATE TYPE "PickupStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EarningStatus" AS ENUM ('PENDING', 'PAID');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "role" "Role" NOT NULL DEFAULT 'CUSTOMER',
    "phone" TEXT,
    "address" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zones" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hubs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "phone" TEXT,
    "zoneId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hubs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serviceType" "ServiceType" NOT NULL,
    "originZoneId" TEXT,
    "destinationZoneId" TEXT,
    "baseFee" DECIMAL(10,2) NOT NULL,
    "baseWeightKg" DECIMAL(8,2) NOT NULL DEFAULT 1,
    "perKgFee" DECIMAL(10,2) NOT NULL,
    "maxWeightKg" DECIMAL(8,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courier_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vehicleType" "VehicleType" NOT NULL,
    "vehicleNumber" TEXT,
    "licenseNumber" TEXT,
    "zoneId" TEXT NOT NULL,
    "hubId" TEXT,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courier_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "trackingId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "courierId" TEXT,
    "senderName" TEXT NOT NULL,
    "senderPhone" TEXT NOT NULL,
    "pickupAddress" TEXT NOT NULL,
    "receiverName" TEXT NOT NULL,
    "receiverPhone" TEXT NOT NULL,
    "receiverEmail" TEXT,
    "deliveryAddress" TEXT NOT NULL,
    "originZoneId" TEXT NOT NULL,
    "destinationZoneId" TEXT NOT NULL,
    "originHubId" TEXT,
    "destinationHubId" TEXT,
    "currentHubId" TEXT,
    "weightKg" DECIMAL(8,2) NOT NULL,
    "description" TEXT,
    "declaredValue" DECIMAL(10,2),
    "isFragile" BOOLEAN NOT NULL DEFAULT false,
    "serviceType" "ServiceType" NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "priceBreakdown" JSONB NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'bdt',
    "status" "ShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "paymentStatus" "ShipmentPaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "cancelReason" TEXT,
    "proofOfDeliveryUrl" TEXT,
    "estimatedDeliveryAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_status_history" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "fromStatus" "ShipmentStatus",
    "toStatus" "ShipmentStatus" NOT NULL,
    "note" TEXT,
    "hubId" TEXT,
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pickup_requests" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "pickupAddress" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "status" "PickupStatus" NOT NULL DEFAULT 'SCHEDULED',
    "completedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pickup_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'bdt',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL DEFAULT 'STRIPE',
    "stripeSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "paidAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courier_earnings" (
    "id" TEXT NOT NULL,
    "courierId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "EarningStatus" NOT NULL DEFAULT 'PENDING',
    "paidOutAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "courier_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" "Role",
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_deletedAt_idx" ON "users"("deletedAt");

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "zones_code_key" ON "zones"("code");

-- CreateIndex
CREATE INDEX "zones_isActive_deletedAt_idx" ON "zones"("isActive", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "hubs_code_key" ON "hubs"("code");

-- CreateIndex
CREATE INDEX "hubs_zoneId_idx" ON "hubs"("zoneId");

-- CreateIndex
CREATE INDEX "hubs_deletedAt_idx" ON "hubs"("deletedAt");

-- CreateIndex
CREATE INDEX "pricing_rules_serviceType_originZoneId_destinationZoneId_idx" ON "pricing_rules"("serviceType", "originZoneId", "destinationZoneId");

-- CreateIndex
CREATE INDEX "pricing_rules_isActive_deletedAt_idx" ON "pricing_rules"("isActive", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "courier_profiles_userId_key" ON "courier_profiles"("userId");

-- CreateIndex
CREATE INDEX "courier_profiles_zoneId_isAvailable_idx" ON "courier_profiles"("zoneId", "isAvailable");

-- CreateIndex
CREATE INDEX "courier_profiles_deletedAt_idx" ON "courier_profiles"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_trackingId_key" ON "shipments"("trackingId");

-- CreateIndex
CREATE INDEX "shipments_status_idx" ON "shipments"("status");

-- CreateIndex
CREATE INDEX "shipments_paymentStatus_idx" ON "shipments"("paymentStatus");

-- CreateIndex
CREATE INDEX "shipments_customerId_createdAt_idx" ON "shipments"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "shipments_courierId_status_idx" ON "shipments"("courierId", "status");

-- CreateIndex
CREATE INDEX "shipments_originZoneId_idx" ON "shipments"("originZoneId");

-- CreateIndex
CREATE INDEX "shipments_destinationZoneId_idx" ON "shipments"("destinationZoneId");

-- CreateIndex
CREATE INDEX "shipments_serviceType_idx" ON "shipments"("serviceType");

-- CreateIndex
CREATE INDEX "shipments_createdAt_idx" ON "shipments"("createdAt");

-- CreateIndex
CREATE INDEX "shipments_deletedAt_idx" ON "shipments"("deletedAt");

-- CreateIndex
CREATE INDEX "shipment_status_history_shipmentId_createdAt_idx" ON "shipment_status_history"("shipmentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "pickup_requests_shipmentId_key" ON "pickup_requests"("shipmentId");

-- CreateIndex
CREATE INDEX "pickup_requests_status_scheduledAt_idx" ON "pickup_requests"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "pickup_requests_deletedAt_idx" ON "pickup_requests"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "payments_stripeSessionId_key" ON "payments"("stripeSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_stripePaymentIntentId_key" ON "payments"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "payments_shipmentId_idx" ON "payments"("shipmentId");

-- CreateIndex
CREATE INDEX "payments_userId_createdAt_idx" ON "payments"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "courier_earnings_shipmentId_key" ON "courier_earnings"("shipmentId");

-- CreateIndex
CREATE INDEX "courier_earnings_courierId_createdAt_idx" ON "courier_earnings"("courierId", "createdAt");

-- CreateIndex
CREATE INDEX "courier_earnings_status_idx" ON "courier_earnings"("status");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_idx" ON "audit_logs"("actorId");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hubs" ADD CONSTRAINT "hubs_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_originZoneId_fkey" FOREIGN KEY ("originZoneId") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_destinationZoneId_fkey" FOREIGN KEY ("destinationZoneId") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_profiles" ADD CONSTRAINT "courier_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_profiles" ADD CONSTRAINT "courier_profiles_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_profiles" ADD CONSTRAINT "courier_profiles_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_originZoneId_fkey" FOREIGN KEY ("originZoneId") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_destinationZoneId_fkey" FOREIGN KEY ("destinationZoneId") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_originHubId_fkey" FOREIGN KEY ("originHubId") REFERENCES "hubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_destinationHubId_fkey" FOREIGN KEY ("destinationHubId") REFERENCES "hubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_currentHubId_fkey" FOREIGN KEY ("currentHubId") REFERENCES "hubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_status_history" ADD CONSTRAINT "shipment_status_history_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_status_history" ADD CONSTRAINT "shipment_status_history_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_status_history" ADD CONSTRAINT "shipment_status_history_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_earnings" ADD CONSTRAINT "courier_earnings_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_earnings" ADD CONSTRAINT "courier_earnings_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
