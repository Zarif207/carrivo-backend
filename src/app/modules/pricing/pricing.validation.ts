import { z } from "zod";
import { ServiceType } from "../../../generated/prisma/enums.js";
import { idParams, moneySchema, weightSchema } from "../../utils/commonValidation.js";
import { booleanQuery, optionalQuery, paginationQueryShape, sortByQuery } from "../../utils/pagination.js";

export const PRICING_SORT_FIELDS = ["name", "serviceType", "baseFee", "perKgFee", "createdAt"] as const;

const serviceType = z.enum(ServiceType, { message: "serviceType must be STANDARD, EXPRESS or SAME_DAY" });
const zoneId = z.uuid({ message: "Invalid zone id" });

const ruleFields = {
  name: z.string().trim().min(2).max(100),
  serviceType,
  // Both null = the default rule for the service type; both set = a specific route.
  originZoneId: zoneId.nullable(),
  destinationZoneId: zoneId.nullable(),
  baseFee: moneySchema,
  baseWeightKg: z.number().min(0).max(1000).transform((v) => Math.round(v * 100) / 100),
  perKgFee: moneySchema,
  maxWeightKg: weightSchema.nullable(),
  isActive: z.boolean(),
};

const bothOrNeither = (body: { originZoneId?: string | null; destinationZoneId?: string | null }): boolean =>
  (body.originZoneId ?? null) === null ? (body.destinationZoneId ?? null) === null : (body.destinationZoneId ?? null) !== null;

const zonePairMessage = {
  message: "Set both originZoneId and destinationZoneId (route rule) or neither (default rule)",
  path: ["destinationZoneId"],
};

const maxAboveBase = (body: { baseWeightKg?: number; maxWeightKg?: number | null }): boolean =>
  body.baseWeightKg === undefined || body.maxWeightKg === undefined || body.maxWeightKg === null
    ? true
    : body.maxWeightKg >= body.baseWeightKg;

const maxMessage = { message: "maxWeightKg must be at least baseWeightKg", path: ["maxWeightKg"] };

const create = z.object({
  body: z
    .strictObject({
      ...ruleFields,
      originZoneId: ruleFields.originZoneId.default(null),
      destinationZoneId: ruleFields.destinationZoneId.default(null),
      baseWeightKg: ruleFields.baseWeightKg.default(1),
      maxWeightKg: ruleFields.maxWeightKg.default(null),
      isActive: ruleFields.isActive.default(true),
    })
    .refine(bothOrNeither, zonePairMessage)
    .refine(maxAboveBase, maxMessage),
});

// Partial update: the zone-pair and max/base checks run again in the service
// on the merged (existing + patch) values.
const update = z.object({
  params: idParams,
  body: z
    .strictObject(ruleFields)
    .partial()
    .refine((body) => Object.keys(body).length > 0, { message: "Provide at least one field to update" })
    .refine(maxAboveBase, maxMessage),
});

const list = z.object({
  query: z.strictObject({
    ...paginationQueryShape,
    sortBy: sortByQuery(PRICING_SORT_FIELDS, "createdAt"),
    serviceType: optionalQuery(serviceType),
    originZoneId: optionalQuery(zoneId),
    destinationZoneId: optionalQuery(zoneId),
    isActive: optionalQuery(booleanQuery),
  }),
});

const estimate = z.object({
  body: z.strictObject({
    weightKg: weightSchema,
    serviceType,
    originZoneId: zoneId,
    destinationZoneId: zoneId,
  }),
});

const byId = z.object({ params: idParams });

export const PricingValidation = { create, update, list, estimate, byId };

export type CreatePricingRuleInput = z.infer<typeof create>["body"];
export type UpdatePricingRuleInput = z.infer<typeof update>["body"];
export type PricingListQuery = z.infer<typeof list>["query"];
export type EstimateInput = z.infer<typeof estimate>["body"];
