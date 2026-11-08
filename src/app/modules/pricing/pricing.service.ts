import httpStatus from "http-status";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { ServiceType } from "../../../generated/prisma/enums.js";
import { CACHE_KEYS, CACHE_TTL, cache } from "../../lib/cache.js";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../utils/ApiError.js";
import { hashKey } from "../../utils/cache.js";
import { formatMoneyFields } from "../../utils/money.js";
import { buildMeta, buildOrderBy, getSkipTake, type Paginated } from "../../utils/pagination.js";
import type { RequestMeta } from "../../utils/requestMeta.js";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../audit/audit.constants.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor } from "../audit/audit.types.js";
import {
  PRICING_MONEY_FIELDS,
  pricingRuleSelect,
  type EstimateResult,
  type PriceSnapshot,
  type PricingRuleDto,
  type PricingRuleRow,
  type QuoteInput,
} from "./pricing.types.js";
import { calculatePrice } from "./pricing.utils.js";
import type {
  CreatePricingRuleInput,
  EstimateInput,
  PricingListQuery,
  UpdatePricingRuleInput,
} from "./pricing.validation.js";

type Db = Prisma.TransactionClient;

const notFound = (): ApiError => new ApiError(httpStatus.NOT_FOUND, "Pricing rule not found");

const toDto = (rule: PricingRuleRow): PricingRuleDto => formatMoneyFields(rule, PRICING_MONEY_FIELDS);

const findExisting = async (db: Db, id: string): Promise<PricingRuleRow> => {
  const rule = await db.pricingRule.findFirst({ where: { id, deletedAt: null }, select: pricingRuleSelect });
  if (!rule) throw notFound();
  return rule;
};

/** Every zone id given must exist, not be deleted and be active. Errors name the body field. */
const assertZonesUsable = async (db: Db, zones: Record<string, string | null>): Promise<void> => {
  const ids = [...new Set(Object.values(zones).filter((id): id is string => id !== null))];
  if (ids.length === 0) return;
  const found = await db.zone.findMany({
    where: { id: { in: ids }, deletedAt: null, isActive: true },
    select: { id: true },
  });
  const usable = new Set(found.map((z) => z.id));
  const errors = Object.entries(zones)
    .filter(([, id]) => id !== null && !usable.has(id))
    .map(([field]) => ({ path: `body.${field}`, message: "Zone not found or inactive" }));
  if (errors.length > 0) throw new ApiError(httpStatus.BAD_REQUEST, "Zone not found or inactive", errors);
};

interface RuleKey {
  serviceType: ServiceType;
  originZoneId: string | null;
  destinationZoneId: string | null;
}

/** One active rule per (serviceType, origin, destination); nulls count as equal here. */
const assertNoActiveDuplicate = async (db: Db, key: RuleKey, excludeId?: string): Promise<void> => {
  const duplicate = await db.pricingRule.findFirst({
    where: {
      // Pick the key fields explicitly: callers may pass a full rule payload.
      serviceType: key.serviceType,
      originZoneId: key.originZoneId,
      destinationZoneId: key.destinationZoneId,
      isActive: true,
      deletedAt: null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, name: true },
  });
  if (duplicate) {
    throw new ApiError(
      httpStatus.CONFLICT,
      `An active pricing rule already exists for this service and route ("${duplicate.name}")`,
      [{ path: "body", message: `Conflicts with pricing rule ${duplicate.id}` }],
    );
  }
};

/** Exact route rule first, then the service type's default rule (both zones null). */
const findApplicableRule = async (db: Db, input: Omit<QuoteInput, "weightLb">) => {
  const select = { id: true, name: true, baseFee: true, baseWeightLb: true, perLbFee: true, maxWeightLb: true } as const;
  const base = { serviceType: input.serviceType, isActive: true, deletedAt: null };
  const exact = await db.pricingRule.findFirst({
    where: { ...base, originZoneId: input.originZoneId, destinationZoneId: input.destinationZoneId },
    orderBy: { createdAt: "desc" },
    select,
  });
  if (exact) return exact;
  return db.pricingRule.findFirst({
    where: { ...base, originZoneId: null, destinationZoneId: null },
    orderBy: { createdAt: "desc" },
    select,
  });
};

/**
 * Server-side price for a route. Used by /pricing/estimate and by shipment
 * create/update, so the estimate and the charged price always agree.
 */
const quote = async (db: Db, input: QuoteInput): Promise<PriceSnapshot> => {
  await assertZonesUsable(db, { originZoneId: input.originZoneId, destinationZoneId: input.destinationZoneId });

  const rule = await findApplicableRule(db, input);
  if (!rule) {
    throw new ApiError(httpStatus.UNPROCESSABLE_ENTITY, "No pricing available for this service and route", [
      { path: "body.serviceType", message: `${input.serviceType} is not offered between these zones` },
    ]);
  }

  const result = calculatePrice(rule, input.weightLb);
  if (!result.ok) {
    const message =
      result.reason === "WEIGHT_EXCEEDS_MAX"
        ? `Weight exceeds the ${result.maxWeightLb} lb limit for ${input.serviceType}`
        : "Weight must be greater than 0";
    throw new ApiError(httpStatus.UNPROCESSABLE_ENTITY, message, [{ path: "body.weightLb", message }]);
  }

  return {
    ...result.breakdown,
    serviceType: input.serviceType,
    ruleId: rule.id,
    ruleName: rule.name,
    calculatedAt: new Date().toISOString(),
  };
};

/**
 * Public estimate, cached 120 s per validated body. Shipment create/update always
 * call quote() directly, so the charged price never comes from the cache.
 */
const estimate = (input: EstimateInput): Promise<EstimateResult> =>
  cache.getOrLoadField(CACHE_KEYS.pricingEstimate, hashKey(input), CACHE_TTL.pricingEstimate, async () => {
    const { ruleId: _ruleId, ruleName: _ruleName, calculatedAt: _at, ...publicBreakdown } = await quote(prisma, input);
    return publicBreakdown;
  });

const list = async (query: PricingListQuery): Promise<Paginated<PricingRuleDto>> => {
  const where: Prisma.PricingRuleWhereInput = {
    deletedAt: null,
    ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    ...(query.serviceType ? { serviceType: query.serviceType } : {}),
    ...(query.originZoneId ? { originZoneId: query.originZoneId } : {}),
    ...(query.destinationZoneId ? { destinationZoneId: query.destinationZoneId } : {}),
    ...(query.searchTerm ? { name: { contains: query.searchTerm, mode: "insensitive" } } : {}),
  };
  // Two independent reads (a batch transaction adds no consistency under READ COMMITTED,
  // and with many relations it makes Prisma overlap queries on one connection).
  const [data, total] = await Promise.all([
    prisma.pricingRule.findMany({
      where,
      select: pricingRuleSelect,
      orderBy: buildOrderBy(query.sortBy, query.sortOrder),
      ...getSkipTake(query),
    }),
    prisma.pricingRule.count({ where }),
  ]);
  return { data: data.map(toDto), meta: buildMeta(query, total) };
};

const getById = async (id: string): Promise<PricingRuleDto> => toDto(await findExisting(prisma, id));

const createTx = (payload: CreatePricingRuleInput, actor: Actor, meta: RequestMeta): Promise<PricingRuleDto> =>
  prisma.$transaction(async (tx) => {
    await assertZonesUsable(tx, { originZoneId: payload.originZoneId, destinationZoneId: payload.destinationZoneId });
    if (payload.isActive) {
      await assertNoActiveDuplicate(tx, payload);
    }
    const rule = await tx.pricingRule.create({ data: payload, select: pricingRuleSelect });
    await AuditService.log(tx, {
      actor,
      action: AUDIT_ACTIONS.PRICING_RULE_CREATED,
      entityType: AUDIT_ENTITIES.PRICING_RULE,
      entityId: rule.id,
      after: rule,
      meta,
    });
    return toDto(rule);
  });

const updateTx = (
  id: string,
  payload: UpdatePricingRuleInput,
  actor: Actor,
  meta: RequestMeta,
): Promise<PricingRuleDto> =>
  prisma.$transaction(async (tx) => {
    const before = await findExisting(tx, id);

    // Validate the rule as it will be after the patch.
    const merged = {
      serviceType: payload.serviceType ?? before.serviceType,
      originZoneId: payload.originZoneId !== undefined ? payload.originZoneId : (before.originZone?.id ?? null),
      destinationZoneId:
        payload.destinationZoneId !== undefined ? payload.destinationZoneId : (before.destinationZone?.id ?? null),
      baseWeightLb: payload.baseWeightLb ?? before.baseWeightLb.toNumber(),
      maxWeightLb: payload.maxWeightLb !== undefined ? payload.maxWeightLb : (before.maxWeightLb?.toNumber() ?? null),
      isActive: payload.isActive ?? before.isActive,
    };
    if ((merged.originZoneId === null) !== (merged.destinationZoneId === null)) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Validation failed", [
        { path: "body.destinationZoneId", message: "Set both originZoneId and destinationZoneId or neither" },
      ]);
    }
    if (merged.maxWeightLb !== null && merged.maxWeightLb < merged.baseWeightLb) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Validation failed", [
        { path: "body.maxWeightLb", message: "maxWeightLb must be at least baseWeightLb" },
      ]);
    }
    await assertZonesUsable(tx, {
      ...(payload.originZoneId !== undefined ? { originZoneId: payload.originZoneId } : {}),
      ...(payload.destinationZoneId !== undefined ? { destinationZoneId: payload.destinationZoneId } : {}),
    });
    if (merged.isActive) {
      await assertNoActiveDuplicate(
        tx,
        { serviceType: merged.serviceType, originZoneId: merged.originZoneId, destinationZoneId: merged.destinationZoneId },
        id,
      );
    }

    const rule = await tx.pricingRule.update({ where: { id }, data: payload, select: pricingRuleSelect });
    await AuditService.log(tx, {
      actor,
      action: AUDIT_ACTIONS.PRICING_RULE_UPDATED,
      entityType: AUDIT_ENTITIES.PRICING_RULE,
      entityId: id,
      before,
      after: rule,
      meta,
    });
    return toDto(rule);
  });

const removeTx = (id: string, actor: Actor, meta: RequestMeta): Promise<PricingRuleDto> =>
  prisma.$transaction(async (tx) => {
    const before = await findExisting(tx, id);
    const rule = await tx.pricingRule.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
      select: pricingRuleSelect,
    });
    await AuditService.log(tx, {
      actor,
      action: AUDIT_ACTIONS.PRICING_RULE_DELETED,
      entityType: AUDIT_ENTITIES.PRICING_RULE,
      entityId: id,
      before,
      meta,
    });
    return toDto(rule);
  });

const withEstimateInvalidation =
  <A extends unknown[]>(fn: (...args: A) => Promise<PricingRuleDto>) =>
  async (...args: A): Promise<PricingRuleDto> => {
    const rule = await fn(...args);
    await cache.invalidate(CACHE_KEYS.pricingEstimate);
    return rule;
  };

const create = withEstimateInvalidation(createTx);
const update = withEstimateInvalidation(updateTx);
const remove = withEstimateInvalidation(removeTx);

export const PricingService = { quote, estimate, list, getById, create, update, remove };
