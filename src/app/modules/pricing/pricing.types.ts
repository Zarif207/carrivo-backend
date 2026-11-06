import type { Prisma } from "../../../generated/prisma/client.js";
import type { ServiceType } from "../../../generated/prisma/enums.js";
import type { WithMoney } from "../../utils/money.js";
import { zoneRefSelect } from "../zone/zone.types.js";
import type { PriceBreakdown } from "./pricing.utils.js";

export const pricingRuleSelect = {
  id: true,
  name: true,
  serviceType: true,
  originZone: { select: zoneRefSelect },
  destinationZone: { select: zoneRefSelect },
  baseFee: true,
  baseWeightKg: true,
  perKgFee: true,
  maxWeightKg: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PricingRuleSelect;

/** Row as read from the DB (Decimal money). */
export type PricingRuleRow = Prisma.PricingRuleGetPayload<{ select: typeof pricingRuleSelect }>;

export const PRICING_MONEY_FIELDS = ["baseFee", "perKgFee"] as const;

/** API shape: money fields as 2-decimal strings. */
export type PricingRuleDto = WithMoney<PricingRuleRow, (typeof PRICING_MONEY_FIELDS)[number]>;

export interface QuoteInput {
  serviceType: ServiceType;
  originZoneId: string;
  destinationZoneId: string;
  weightKg: number;
}

/** Public estimate: the breakdown plus the service type. No rule id or other internals. */
export type EstimateResult = PriceBreakdown & {
  serviceType: ServiceType;
};

/** Stored on Shipment.priceBreakdown as a snapshot of how the price was made. */
export type PriceSnapshot = PriceBreakdown & {
  serviceType: ServiceType;
  ruleId: string;
  ruleName: string;
  calculatedAt: string;
};
