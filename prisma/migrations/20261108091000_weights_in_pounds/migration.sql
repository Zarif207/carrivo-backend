-- Weights move from kilograms to pounds (1 kg = 2.20462 lb). Columns are renamed and existing
-- values converted in place; the per-unit fee is divided so existing rules keep charging about
-- the same money. Stored price snapshots (shipments."priceBreakdown") are rewritten to the new
-- keys; their money values (baseFee, weightCharge, total) are historical and stay unchanged.

-- Shipments
ALTER TABLE "shipments" RENAME COLUMN "weightKg" TO "weightLb";
UPDATE "shipments" SET "weightLb" = ROUND("weightLb" * 2.20462, 2);

-- Pricing rules
ALTER TABLE "pricing_rules" RENAME COLUMN "baseWeightKg" TO "baseWeightLb";
ALTER TABLE "pricing_rules" RENAME COLUMN "perKgFee" TO "perLbFee";
ALTER TABLE "pricing_rules" RENAME COLUMN "maxWeightKg" TO "maxWeightLb";
UPDATE "pricing_rules"
SET "baseWeightLb" = ROUND("baseWeightLb" * 2.20462, 2),
    "maxWeightLb"  = ROUND("maxWeightLb" * 2.20462, 2),
    "perLbFee"     = ROUND("perLbFee" / 2.20462, 2);

-- Price snapshots: rename the kg keys and convert their values (strings with 2 decimals).
UPDATE "shipments"
SET "priceBreakdown" =
      ("priceBreakdown" - 'weightKg' - 'baseWeightKg' - 'chargeableExtraKg' - 'perKgFee')
      || jsonb_build_object(
           'weightLb',          to_char(ROUND(("priceBreakdown"->>'weightKg')::numeric * 2.20462, 2), 'FM999999990.00'),
           'baseWeightLb',      to_char(ROUND(("priceBreakdown"->>'baseWeightKg')::numeric * 2.20462, 2), 'FM999999990.00'),
           'chargeableExtraLb', to_char(ROUND(("priceBreakdown"->>'chargeableExtraKg')::numeric * 2.20462, 2), 'FM999999990.00'),
           'perLbFee',          to_char(ROUND(("priceBreakdown"->>'perKgFee')::numeric / 2.20462, 2), 'FM999999990.00')
         )
WHERE "priceBreakdown" ? 'weightKg';
