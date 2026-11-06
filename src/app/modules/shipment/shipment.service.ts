import httpStatus from "http-status";
import type { Prisma } from "../../../generated/prisma/client.js";
import { Role, ShipmentPaymentStatus, ShipmentStatus } from "../../../generated/prisma/enums.js";
import { prisma } from "../../lib/prisma.js";
import type { ErrorDetail } from "../../types/response.types.js";
import { ApiError } from "../../utils/ApiError.js";
import { formatMoneyFields } from "../../utils/money.js";
import { buildMeta, buildOrderBy, getSkipTake, type Paginated } from "../../utils/pagination.js";
import type { RequestMeta } from "../../utils/requestMeta.js";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../audit/audit.constants.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor } from "../audit/audit.types.js";
import { PricingService } from "../pricing/pricing.service.js";
import { ADMIN_DELETABLE_STATUSES, allowedTransitions, transitionRoles } from "./shipment.constants.js";
import {
  SHIPMENT_DETAIL_MONEY_FIELDS,
  SHIPMENT_LIST_MONEY_FIELDS,
  shipmentDetailSelect,
  shipmentListSelect,
  type ChangeStatusInput,
  type ShipmentDetail,
  type ShipmentListItem,
} from "./shipment.types.js";
import { withTrackingIdRetry } from "./shipment.utils.js";
import type { CreateShipmentInput, ShipmentListQuery, UpdateShipmentInput } from "./shipment.validation.js";

type Db = Prisma.TransactionClient;

// 404 (not 403) for shipments outside the caller's scope, so ids can't be probed.
const notFound = (): ApiError => new ApiError(httpStatus.NOT_FOUND, "Shipment not found");
const conflict = (message: string, errors: ErrorDetail[] = []): ApiError =>
  new ApiError(httpStatus.CONFLICT, message, errors);

/** Customer: own shipments. Courier: assigned shipments. Admin: everything. */
const scopeWhere = (actor: Actor): Prisma.ShipmentWhereInput => {
  switch (actor.role) {
    case Role.CUSTOMER:
      return { customerId: actor.id };
    case Role.COURIER:
      return { courierId: actor.id };
    case Role.ADMIN:
      return {};
  }
};

/**
 * Loaded AFTER the write transaction commits. The detail select has many relations,
 * and inside a transaction Prisma would run them concurrently on the one connection
 * (deprecated by pg, removed in pg@9).
 */
const loadDetail = async (id: string): Promise<ShipmentDetail> =>
  formatMoneyFields(
    await prisma.shipment.findUniqueOrThrow({ where: { id }, select: shipmentDetailSelect }),
    SHIPMENT_DETAIL_MONEY_FIELDS,
  );

/** Flat (relation-free) snapshot of the editable columns, for update checks and audit. */
const editSnapshotSelect = {
  id: true,
  status: true,
  paymentStatus: true,
  originZoneId: true,
  destinationZoneId: true,
  senderName: true,
  senderPhone: true,
  pickupAddress: true,
  receiverName: true,
  receiverPhone: true,
  receiverEmail: true,
  deliveryAddress: true,
  description: true,
  declaredValue: true,
  isFragile: true,
  weightKg: true,
  serviceType: true,
  price: true,
} as const satisfies Prisma.ShipmentSelect;

/** Each hub must be active and belong to the zone sent with it. */
const assertHubsMatchZones = async (db: Db, payload: CreateShipmentInput): Promise<void> => {
  const pairs = [
    { field: "originHubId", hubId: payload.originHubId, zoneId: payload.originZoneId, zoneField: "originZoneId" },
    {
      field: "destinationHubId",
      hubId: payload.destinationHubId,
      zoneId: payload.destinationZoneId,
      zoneField: "destinationZoneId",
    },
  ];
  const hubs = await db.hub.findMany({
    where: { id: { in: pairs.map((p) => p.hubId) }, deletedAt: null, isActive: true },
    select: { id: true, zoneId: true },
  });
  const zoneOf = new Map(hubs.map((h) => [h.id, h.zoneId]));
  const errors: ErrorDetail[] = [];
  for (const pair of pairs) {
    const hubZone = zoneOf.get(pair.hubId);
    if (hubZone === undefined) {
      errors.push({ path: `body.${pair.field}`, message: "Hub not found or inactive" });
    } else if (hubZone !== pair.zoneId) {
      errors.push({ path: `body.${pair.field}`, message: `Hub does not belong to ${pair.zoneField}` });
    }
  }
  if (errors.length > 0) throw new ApiError(httpStatus.BAD_REQUEST, "Invalid origin or destination hub", errors);
};

/**
 * THE single entry point for shipment status changes. In one transaction:
 * check the transition map and the actor's role/ownership, enforce the
 * payment rule, update with a status guard (so concurrent changes can't both
 * win), then write the status history row and the audit row.
 */
const changeStatus = async (input: ChangeStatusInput): Promise<ShipmentDetail> => {
  const id = await prisma.$transaction(async (tx) => {
    const { actor, toStatus } = input;
    const shipment = await tx.shipment.findFirst({
      where: { id: input.shipmentId, deletedAt: null, ...scopeWhere(actor) },
      select: { id: true, status: true, paymentStatus: true },
    });
    if (!shipment) throw notFound();
    const from = shipment.status;

    if (!allowedTransitions[from].includes(toStatus)) {
      if (toStatus === ShipmentStatus.CANCELLED) {
        throw conflict(`Shipment can only be cancelled before it is picked up (current status: ${from})`);
      }
      throw conflict(`Cannot change status from ${from} to ${toStatus}`);
    }
    if (!transitionRoles[toStatus]?.includes(actor.role)) {
      throw new ApiError(httpStatus.FORBIDDEN, `Your role cannot move a shipment to ${toStatus}`);
    }
    if (
      from === ShipmentStatus.PENDING &&
      toStatus !== ShipmentStatus.CANCELLED &&
      shipment.paymentStatus !== ShipmentPaymentStatus.PAID
    ) {
      throw conflict("Shipment must be paid before it can move past PENDING");
    }

    const { count } = await tx.shipment.updateMany({
      where: { id: shipment.id, status: from, deletedAt: null },
      data: { ...input.data, status: toStatus },
    });
    if (count === 0) throw conflict("Shipment status changed concurrently, please retry");

    await tx.shipmentStatusHistory.create({
      data: {
        shipmentId: shipment.id,
        fromStatus: from,
        toStatus,
        note: input.note ?? null,
        hubId: input.hubId ?? null,
        changedById: actor.id,
      },
      select: { id: true },
    });
    await AuditService.log(tx, {
      actor,
      action: AUDIT_ACTIONS.SHIPMENT_STATUS_CHANGED,
      entityType: AUDIT_ENTITIES.SHIPMENT,
      entityId: shipment.id,
      before: { status: from },
      after: { status: toStatus, note: input.note ?? null, ...input.data },
      meta: input.meta,
    });
    return shipment.id;
  });
  return loadDetail(id);
};

const create = async (actor: Actor, payload: CreateShipmentInput, meta: RequestMeta): Promise<ShipmentDetail> => {
  // Retries the whole transaction only on a trackingId collision (see withTrackingIdRetry).
  const id = await withTrackingIdRetry((trackingId) =>
    prisma.$transaction(async (tx) => {
      await assertHubsMatchZones(tx, payload);
      // Server-side price; the strict body schema already rejects any client price.
      const snapshot = await PricingService.quote(tx, payload);

      const shipment = await tx.shipment.create({
        data: {
          trackingId,
          customerId: actor.id,
          senderName: payload.senderName,
          senderPhone: payload.senderPhone,
          pickupAddress: payload.pickupAddress,
          receiverName: payload.receiverName,
          receiverPhone: payload.receiverPhone,
          receiverEmail: payload.receiverEmail ?? null,
          deliveryAddress: payload.deliveryAddress,
          originZoneId: payload.originZoneId,
          originHubId: payload.originHubId,
          destinationZoneId: payload.destinationZoneId,
          destinationHubId: payload.destinationHubId,
          weightKg: payload.weightKg,
          description: payload.description ?? null,
          declaredValue: payload.declaredValue ?? null,
          isFragile: payload.isFragile ?? false,
          serviceType: payload.serviceType,
          price: snapshot.total,
          priceBreakdown: snapshot,
          currency: snapshot.currency,
          status: ShipmentStatus.PENDING,
        },
        select: { id: true },
      });
      await tx.shipmentStatusHistory.create({
        data: {
          shipmentId: shipment.id,
          fromStatus: null,
          toStatus: ShipmentStatus.PENDING,
          note: "Shipment created",
          hubId: payload.originHubId,
          changedById: actor.id,
        },
        select: { id: true },
      });
      await AuditService.log(tx, {
        actor,
        action: AUDIT_ACTIONS.SHIPMENT_CREATED,
        entityType: AUDIT_ENTITIES.SHIPMENT,
        entityId: shipment.id,
        after: { trackingId, status: ShipmentStatus.PENDING, price: snapshot.total, serviceType: payload.serviceType },
        meta,
      });
      return shipment.id;
    }),
  );
  return loadDetail(id);
};

const list = async (actor: Actor, query: ShipmentListQuery): Promise<Paginated<ShipmentListItem>> => {
  const filters: Prisma.ShipmentWhereInput[] = [{ deletedAt: null }, scopeWhere(actor)];
  if (query.status) filters.push({ status: query.status });
  if (query.serviceType) filters.push({ serviceType: query.serviceType });
  if (query.paymentStatus) filters.push({ paymentStatus: query.paymentStatus });
  if (query.customerId) filters.push({ customerId: query.customerId });
  if (query.courierId) filters.push({ courierId: query.courierId });
  if (query.fromDate || query.toDate) {
    filters.push({
      createdAt: { ...(query.fromDate ? { gte: query.fromDate } : {}), ...(query.toDate ? { lte: query.toDate } : {}) },
    });
  }
  if (query.searchTerm) {
    // Served by the pg_trgm GIN indexes on these three columns.
    filters.push({
      OR: [
        { trackingId: { contains: query.searchTerm, mode: "insensitive" } },
        { receiverName: { contains: query.searchTerm, mode: "insensitive" } },
        { receiverPhone: { contains: query.searchTerm, mode: "insensitive" } },
      ],
    });
  }
  const where: Prisma.ShipmentWhereInput = { AND: filters };

  // Two independent reads (a batch transaction adds no consistency under READ COMMITTED,
  // and with many relations it makes Prisma overlap queries on one connection).
  const [data, total] = await Promise.all([
    prisma.shipment.findMany({
      where,
      select: shipmentListSelect,
      orderBy: buildOrderBy(query.sortBy, query.sortOrder),
      ...getSkipTake(query),
    }),
    prisma.shipment.count({ where }),
  ]);
  return { data: data.map((row) => formatMoneyFields(row, SHIPMENT_LIST_MONEY_FIELDS)), meta: buildMeta(query, total) };
};

const getById = async (actor: Actor, id: string): Promise<ShipmentDetail> => {
  const shipment = await prisma.shipment.findFirst({
    where: { id, deletedAt: null, ...scopeWhere(actor) },
    select: shipmentDetailSelect,
  });
  if (!shipment) throw notFound();
  return formatMoneyFields(shipment, SHIPMENT_DETAIL_MONEY_FIELDS);
};

/** Owner only, PENDING only. Weight/service changes re-price, and are blocked once paid. */
const update = async (
  actor: Actor,
  id: string,
  payload: UpdateShipmentInput,
  meta: RequestMeta,
): Promise<ShipmentDetail> => {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.shipment.findFirst({
      where: { id, deletedAt: null, customerId: actor.id },
      select: editSnapshotSelect,
    });
    if (!existing) throw notFound();
    if (existing.status !== ShipmentStatus.PENDING) {
      throw conflict(`Shipment can only be edited while PENDING (current status: ${existing.status})`);
    }

    const weightChanged = payload.weightKg !== undefined && !existing.weightKg.equals(payload.weightKg);
    const serviceChanged = payload.serviceType !== undefined && payload.serviceType !== existing.serviceType;
    const repriced = weightChanged || serviceChanged;

    if (repriced && existing.paymentStatus === ShipmentPaymentStatus.PAID) {
      throw conflict("Weight and service type cannot be changed after payment", [
        ...(weightChanged ? [{ path: "body.weightKg", message: "Locked after payment" }] : []),
        ...(serviceChanged ? [{ path: "body.serviceType", message: "Locked after payment" }] : []),
      ]);
    }

    const data: Prisma.ShipmentUpdateManyMutationInput = { ...payload };
    if (repriced) {
      const snapshot = await PricingService.quote(tx, {
        serviceType: payload.serviceType ?? existing.serviceType,
        weightKg: payload.weightKg ?? existing.weightKg.toNumber(),
        originZoneId: existing.originZoneId,
        destinationZoneId: existing.destinationZoneId,
      });
      data.price = snapshot.total;
      data.priceBreakdown = snapshot;
    }

    // Guard on status (and on payment status when re-pricing) against concurrent changes.
    const { count } = await tx.shipment.updateMany({
      where: {
        id,
        deletedAt: null,
        status: ShipmentStatus.PENDING,
        ...(repriced ? { paymentStatus: existing.paymentStatus } : {}),
      },
      data,
    });
    if (count === 0) throw conflict("Shipment changed concurrently, please retry");

    // Before and after both come from the DB row, so values are formatted the same way.
    const after = await tx.shipment.findUniqueOrThrow({ where: { id }, select: editSnapshotSelect });
    type SnapshotKey = keyof typeof existing;
    const changedKeys = Object.keys(data).filter((key): key is SnapshotKey => key in existing);
    await AuditService.log(tx, {
      actor,
      action: AUDIT_ACTIONS.SHIPMENT_UPDATED,
      entityType: AUDIT_ENTITIES.SHIPMENT,
      entityId: id,
      before: Object.fromEntries(changedKeys.map((key) => [key, existing[key]])),
      after: Object.fromEntries(changedKeys.map((key) => [key, after[key]])),
      meta,
    });
  });
  return loadDetail(id);
};

/** Owner (customer) or admin, before PICKED_UP. Paid shipments keep paymentStatus PAID. */
const cancel = (actor: Actor, id: string, reason: string | undefined, meta: RequestMeta): Promise<ShipmentDetail> =>
  changeStatus({
    shipmentId: id,
    toStatus: ShipmentStatus.CANCELLED,
    actor,
    meta,
    note: reason ?? "Cancelled",
    data: { cancelledAt: new Date(), cancelReason: reason ?? null },
  });

/** Admin soft delete; only for shipments that aren't moving (PENDING or finished). */
const remove = (actor: Actor, id: string, meta: RequestMeta): Promise<{ id: string; trackingId: string; deletedAt: Date }> =>
  prisma.$transaction(async (tx) => {
    const shipment = await tx.shipment.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, trackingId: true, status: true },
    });
    if (!shipment) throw notFound();
    if (!ADMIN_DELETABLE_STATUSES.includes(shipment.status)) {
      throw conflict(
        `Only PENDING or finished shipments can be deleted (current status: ${shipment.status}). Cancel it first if possible.`,
      );
    }
    const deletedAt = new Date();
    const { count } = await tx.shipment.updateMany({
      where: { id, deletedAt: null, status: shipment.status },
      data: { deletedAt },
    });
    if (count === 0) throw conflict("Shipment changed concurrently, please retry");
    await AuditService.log(tx, {
      actor,
      action: AUDIT_ACTIONS.SHIPMENT_DELETED,
      entityType: AUDIT_ENTITIES.SHIPMENT,
      entityId: id,
      before: { trackingId: shipment.trackingId, status: shipment.status },
      after: { deletedAt },
      meta,
    });
    return { id, trackingId: shipment.trackingId, deletedAt };
  });

export const ShipmentService = { changeStatus, create, list, getById, update, cancel, remove };
