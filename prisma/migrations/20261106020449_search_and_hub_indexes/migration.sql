-- Trigram matching for the shipment search (ILIKE %term%) GIN indexes below.
-- Added by hand: the schema-level `extensions` field is a preview feature in Prisma 7,
-- and Prisma ignores extensions when that feature is off, so this causes no drift.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "courier_profiles_hubId_idx" ON "courier_profiles"("hubId");

-- CreateIndex
CREATE INDEX "shipments_originHubId_idx" ON "shipments"("originHubId");

-- CreateIndex
CREATE INDEX "shipments_destinationHubId_idx" ON "shipments"("destinationHubId");

-- CreateIndex
CREATE INDEX "shipments_currentHubId_idx" ON "shipments"("currentHubId");

-- CreateIndex
CREATE INDEX "shipments_trackingId_trgm_idx" ON "shipments" USING GIN ("trackingId" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "shipments_receiverName_trgm_idx" ON "shipments" USING GIN ("receiverName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "shipments_receiverPhone_trgm_idx" ON "shipments" USING GIN ("receiverPhone" gin_trgm_ops);
