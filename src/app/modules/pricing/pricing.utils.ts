import { Prisma } from "../../../generated/prisma/client.js";
import { PLATFORM_CURRENCY, type PlatformCurrency } from "../../config/currency.js";

/** Decimal-safe input: a Prisma Decimal from the DB, or a number/string from the request. */
export type DecimalInput = Prisma.Decimal | number | string;

export interface PricingRates {
  baseFee: DecimalInput;
  baseWeightLb: DecimalInput;
  perLbFee: DecimalInput;
  maxWeightLb: DecimalInput | null;
}

/** Money as 2-decimal strings so the JSON never carries float artefacts. */
// `type` (not interface) so it is assignable to Prisma JSON input.
export type PriceBreakdown = {
  currency: PlatformCurrency;
  weightLb: string;
  baseWeightLb: string;
  chargeableExtraLb: string;
  baseFee: string;
  perLbFee: string;
  weightCharge: string;
  total: string;
};

export type PriceResult =
  | { ok: true; breakdown: PriceBreakdown }
  | { ok: false; reason: "WEIGHT_EXCEEDS_MAX"; maxWeightLb: string }
  | { ok: false; reason: "INVALID_WEIGHT" };

const D = (value: DecimalInput): Prisma.Decimal => new Prisma.Decimal(value);

/**
 * Pure price calculation (no DB, no I/O). Weights are in pounds, money in USD:
 *   total = baseFee + ceil(max(0, weight - baseWeight)) * perLbFee
 * Extra weight is charged per started pound (3.2 lb over a 2 lb base → 2 lb).
 */
export const calculatePrice = (rates: PricingRates, weightLb: DecimalInput): PriceResult => {
  const weight = D(weightLb);
  if (!weight.isFinite() || weight.lte(0)) return { ok: false, reason: "INVALID_WEIGHT" };

  if (rates.maxWeightLb !== null && weight.gt(D(rates.maxWeightLb))) {
    return { ok: false, reason: "WEIGHT_EXCEEDS_MAX", maxWeightLb: D(rates.maxWeightLb).toFixed(2) };
  }

  const baseWeight = D(rates.baseWeightLb);
  const baseFee = D(rates.baseFee);
  const perLbFee = D(rates.perLbFee);

  const extra = Prisma.Decimal.max(0, weight.minus(baseWeight));
  const chargeableExtraLb = extra.ceil();
  const weightCharge = chargeableExtraLb.times(perLbFee);
  const total = baseFee.plus(weightCharge);

  return {
    ok: true,
    breakdown: {
      currency: PLATFORM_CURRENCY,
      weightLb: weight.toFixed(2),
      baseWeightLb: baseWeight.toFixed(2),
      chargeableExtraLb: chargeableExtraLb.toFixed(2),
      baseFee: baseFee.toFixed(2),
      perLbFee: perLbFee.toFixed(2),
      weightCharge: weightCharge.toFixed(2),
      total: total.toFixed(2),
    },
  };
};
