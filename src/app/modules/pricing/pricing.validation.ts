import { z } from "zod";
import { ServiceType } from "../../../generated/prisma/enums.js";
import { idParams, moneySchema, weightSchema, MAX_WEIGHT_LB } from "../../utils/commonValidation.js";
import { booleanQuery, optionalQuery, paginationQueryShape, sortByQuery } from "../../utils/pagination.js";

export const PRICING_SORT_FIELDS = ["name", "serviceType", "baseFee", "perLbFee", "createdAt"] as const;

const serviceType = z.enum(ServiceType, { message: "serviceType must be STANDARD, EXPRESS or SAME_DAY" });
const zoneId = z.uuid({ message: "Invalid zone id" });

const ruleFields = {
  name: z.string().trim().min(2).max(100),
  serviceType,
  // Both null = the default rule for the service type; both set = a specific route.
  originZoneId: zoneId.nullable(),
  destinationZoneId: zoneId.nullable(),
  baseFee: moneySchema,
  baseWeightLb: z.number().min(0).max(MAX_WEIGHT_LB).transform((v) => Math.round(v * 100) / 100),
  perLbFee: moneySchema,
  maxWeightLb: weightSchema.nullable(),
  isActive: z.boolean(),
};

const bothOrNeither = (body: { originZoneId?: string | null; destinationZoneId?: string | null }): boolean =>
  (body.originZoneId ?? null) === null ? (body.destinationZoneId ?? null) === null : (body.destinationZoneId ?? null) !== null;

const zonePairMessage = {
  message: "Set both originZoneId and destinationZoneId (route rule) or neither (default rule)",
  path: ["destinationZoneId"],
};

const maxAboveBase = (body: { baseWeightLb?: number; maxWeightLb?: number | null }): boolean =>
  body.baseWeightLb === undefined || body.maxWeightLb === undefined || body.maxWeightLb === null
    ? true
    : body.maxWeightLb >= body.baseWeightLb;

const maxMessage = { message: "maxWeightLb must be at least baseWeightLb", path: ["maxWeightLb"] };

const create = z.object({
  body: z
    .strictObject({
      ...ruleFields,
      originZoneId: ruleFields.originZoneId.default(null),
      destinationZoneId: ruleFields.destinationZoneId.default(null),
      baseWeightLb: ruleFields.baseWeightLb.default(1),
      maxWeightLb: ruleFields.maxWeightLb.default(null),
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
    weightLb: weightSchema,
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
