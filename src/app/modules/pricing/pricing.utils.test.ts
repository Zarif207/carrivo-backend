import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "../../../generated/prisma/client.js";
import { calculatePrice, type PricingRates } from "./pricing.utils.js";

const rates: PricingRates = { baseFee: 60, baseWeightKg: 1, perKgFee: 15, maxWeightKg: 50 };

const total = (weight: number | string, r: PricingRates = rates): string => {
  const result = calculatePrice(r, weight);
  assert.ok(result.ok, "expected a price");
  return result.breakdown.total;
};

describe("calculatePrice", () => {
  it("charges only the base fee at or under the base weight", () => {
    assert.equal(total(0.5), "60.00");
    assert.equal(total(1), "60.00");
  });

  it("charges extra weight per started kilogram", () => {
    const result = calculatePrice(rates, 2.3);
    assert.ok(result.ok);
    assert.deepEqual(result.breakdown, {
      currency: "bdt",
      weightKg: "2.30",
      baseWeightKg: "1.00",
      chargeableExtraKg: "2.00",
      baseFee: "60.00",
      perKgFee: "15.00",
      weightCharge: "30.00",
      total: "90.00",
    });
  });

  it("rounds a tiny excess up to a full kilogram", () => {
    assert.equal(total(1.01), "75.00");
    assert.equal(total(3), "90.00");
  });

  it("allows exactly the max weight and rejects anything above it", () => {
    assert.equal(total(50), "795.00");
    const over = calculatePrice(rates, 50.01);
    assert.deepEqual(over, { ok: false, reason: "WEIGHT_EXCEEDS_MAX", maxWeightKg: "50.00" });
  });

  it("has no max when maxWeightKg is null", () => {
    assert.equal(total(500, { ...rates, maxWeightKg: null }), "7545.00");
  });

  it("uses decimal math (no float artefacts)", () => {
    const r: PricingRates = { baseFee: "0.1", baseWeightKg: 0, perKgFee: "0.2", maxWeightKg: null };
    // 0.1 + 1 * 0.2 would be 0.30000000000000004 with floats
    assert.equal(total(1, r), "0.30");
  });

  it("supports a zero per-kg rate", () => {
    assert.equal(total(10, { ...rates, perKgFee: 0 }), "60.00");
  });

  it("accepts Prisma Decimal rates straight from the DB", () => {
    const fromDb: PricingRates = {
      baseFee: new Prisma.Decimal("120.50"),
      baseWeightKg: new Prisma.Decimal("1.00"),
      perKgFee: new Prisma.Decimal("20.25"),
      maxWeightKg: new Prisma.Decimal("30.00"),
    };
    assert.equal(total("4.2", fromDb), "201.50");
  });

  it("rejects zero or negative weight", () => {
    assert.deepEqual(calculatePrice(rates, 0), { ok: false, reason: "INVALID_WEIGHT" });
    assert.deepEqual(calculatePrice(rates, -1), { ok: false, reason: "INVALID_WEIGHT" });
  });
});
