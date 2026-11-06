import { Prisma } from "../../../generated/prisma/client.js";

/** Decimal-safe input: a Prisma Decimal from the DB, or a number/string from the request. */
export type DecimalInput = Prisma.Decimal | number | string;

export interface PricingRates {
  baseFee: DecimalInput;
  baseWeightKg: DecimalInput;
  perKgFee: DecimalInput;
  maxWeightKg: DecimalInput | null;
}

/** Money as 2-decimal strings so the JSON never carries float artefacts. */
// `type` (not interface) so it is assignable to Prisma JSON input.
export type PriceBreakdown = {
  currency: "bdt";
  weightKg: string;
  baseWeightKg: string;
  chargeableExtraKg: string;
  baseFee: string;
  perKgFee: string;
  weightCharge: string;
  total: string;
};

export type PriceResult =
  | { ok: true; breakdown: PriceBreakdown }
  | { ok: false; reason: "WEIGHT_EXCEEDS_MAX"; maxWeightKg: string }
  | { ok: false; reason: "INVALID_WEIGHT" };

const D = (value: DecimalInput): Prisma.Decimal => new Prisma.Decimal(value);

/**
 * Pure price calculation (no DB, no I/O):
 *   total = baseFee + ceil(max(0, weight - baseWeight)) * perKgFee
 * Extra weight is charged per started kilogram (2.3 kg over a 1 kg base → 2 kg).
 */
export const calculatePrice = (rates: PricingRates, weightKg: DecimalInput): PriceResult => {
  const weight = D(weightKg);
  if (!weight.isFinite() || weight.lte(0)) return { ok: false, reason: "INVALID_WEIGHT" };

  if (rates.maxWeightKg !== null && weight.gt(D(rates.maxWeightKg))) {
    return { ok: false, reason: "WEIGHT_EXCEEDS_MAX", maxWeightKg: D(rates.maxWeightKg).toFixed(2) };
  }

  const baseWeight = D(rates.baseWeightKg);
  const baseFee = D(rates.baseFee);
  const perKgFee = D(rates.perKgFee);

  const extra = Prisma.Decimal.max(0, weight.minus(baseWeight));
  const chargeableExtraKg = extra.ceil();
  const weightCharge = chargeableExtraKg.times(perKgFee);
  const total = baseFee.plus(weightCharge);

  return {
    ok: true,
    breakdown: {
      currency: "bdt",
      weightKg: weight.toFixed(2),
      baseWeightKg: baseWeight.toFixed(2),
      chargeableExtraKg: chargeableExtraKg.toFixed(2),
      baseFee: baseFee.toFixed(2),
      perKgFee: perKgFee.toFixed(2),
      weightCharge: weightCharge.toFixed(2),
      total: total.toFixed(2),
    },
  };
};
