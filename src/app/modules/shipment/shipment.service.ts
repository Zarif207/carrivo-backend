import httpStatus from "http-status";
import type { Prisma } from "../../../generated/prisma/client.js";
import { PickupStatus, Role, ShipmentPaymentStatus, ShipmentStatus, UserStatus } from "../../../generated/prisma/enums.js";
import { CACHE_KEYS, cache } from "../../lib/cache.js";
import { PROOF_FOLDER, deleteImage, uploadImageBuffer } from "../../lib/cloudinary.js";
import { prisma } from "../../lib/prisma.js";
import type { ErrorDetail } from "../../types/response.types.js";
import { ApiError } from "../../utils/ApiError.js";
import { formatMoneyFields } from "../../utils/money.js";
import { buildMeta, buildOrderBy, getSkipTake, type Paginated } from "../../utils/pagination.js";
import type { RequestMeta } from "../../utils/requestMeta.js";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../audit/audit.constants.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor } from "../audit/audit.types.js";
import { NotificationService } from "../notification/notification.service.js";
import { PaymentService } from "../payment/payment.service.js";
import { PricingService } from "../pricing/pricing.service.js";
import { calculateCourierEarning } from "../courier/courier.utils.js";
import {
  ADMIN_DELETABLE_STATUSES,
  MAX_DELIVERY_ATTEMPTS,
  canRoleTransition,
  getAllowedNextStatuses,
  isTransitionLegal,
} from "./shipment.constants.js";
import {
  SHIPMENT_DETAIL_MONEY_FIELDS,
  SHIPMENT_LIST_MONEY_FIELDS,
  shipmentDetailSelect,
  shipmentListSelect,
  statusSnapshotSelect,
  type ChangeStatusInput,
  type ShipmentDetail,
  type ShipmentDetailRow,
  type ShipmentListItem,
  type StatusSnapshot,
} from "./shipment.types.js";
import { withTrackingIdRetry } from "./shipment.utils.js";
import type {
  AssignInput,
  CreateShipmentInput,
  PickupInput,
  ShipmentListQuery,
  UnassignInput,
  UpdateShipmentInput,
  UpdateStatusInput,
} from "./shipment.validation.js";

type Db = Prisma.TransactionClient;

// 404 (not 403) for shipments outside the caller's scope, so ids can't be probed.
const notFound = (): ApiError => new ApiError(httpStatus.NOT_FOUND, "Shipment not found");
const conflict = (message: string, errors: ErrorDetail[] = []): ApiError =>
  new ApiError(httpStatus.CONFLICT, message, errors);

/** Customer: own shipments. Courier: assigned shipments. Admin and ADMIN_VIEWER: everything. */
const scopeWhere = (actor: Actor): Prisma.ShipmentWhereInput => {
  switch (actor.role) {
    case Role.CUSTOMER:
      return { customerId: actor.id };
    case Role.COURIER:
      return { courierId: actor.id };
    case Role.ADMIN:
    case Role.ADMIN_VIEWER:
      return {};
  }
};

/**
 * Loaded AFTER the write transaction commits. The detail select has many relations,
 * and inside a transaction Prisma would run them concurrently on the one connection
 * (deprecated by pg, removed in pg@9).
 */
const loadDetail = async (id: string): Promise<ShipmentDetail> =>
  toDetail(await prisma.shipment.findUniqueOrThrow({ where: { id }, select: shipmentDetailSelect }));

/** Money as 2-decimal strings; the internal pricing-rule id is not exposed. */
const toDetail = (row: ShipmentDetailRow): ShipmentDetail => {
  const detail = formatMoneyFields(row, SHIPMENT_DETAIL_MONEY_FIELDS);
  const breakdown = detail.priceBreakdown;
  if (breakdown && typeof breakdown === "object" && !Array.isArray(breakdown)) {
    const { ruleId: _ruleId, ...rest } = breakdown;
    return { ...detail, priceBreakdown: rest };
  }
  return detail;
};

/** Loads the committed detail and drops the shipment's cached public tracking. */
const loadDetailAndInvalidate = async (id: string): Promise<ShipmentDetail> => {
  const detail = await loadDetail(id);
  await cache.invalidate(CACHE_KEYS.tracking(detail.trackingId));
  return detail;
};

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
  weightLb: true,
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

const badRequest = (message: string, errors: ErrorDetail[] = []): ApiError =>
  new ApiError(httpStatus.BAD_REQUEST, message, errors);

/**
 * Hub for AT_ORIGIN_HUB / AT_DESTINATION_HUB: the one sent, or the shipment's planned
 * hub. It must be active and in the matching (origin/destination) zone.
 */
const resolveHub = async (db: Db, s: StatusSnapshot, toStatus: ShipmentStatus, hubId?: string | null): Promise<string> => {
  const atOrigin = toStatus === ShipmentStatus.AT_ORIGIN_HUB;
  const id = hubId ?? (atOrigin ? s.originHubId : s.destinationHubId);
  if (!id) throw badRequest("hubId is required", [{ path: "body.hubId", message: "The shipment has no planned hub" }]);
  const hub = await db.hub.findFirst({ where: { id, deletedAt: null, isActive: true }, select: { zoneId: true } });
  if (!hub) throw badRequest("Hub not found or inactive", [{ path: "body.hubId", message: "Hub not found or inactive" }]);
  if (hub.zoneId !== (atOrigin ? s.originZoneId : s.destinationZoneId)) {
    const which = atOrigin ? "origin" : "destination";
    throw badRequest(`Hub must be in the shipment's ${which} zone`, [
      { path: "body.hubId", message: `Hub is not in the ${which} zone` },
    ]);
  }
  return id;
};

/** 400 for an illegal move, listing what the caller's role may do next. */
const illegalTransition = (s: StatusSnapshot, toStatus: ShipmentStatus, role: Role): ApiError => {
  const from = s.status;
  let message = `Cannot change status from ${from} to ${toStatus}`;
  if (toStatus === ShipmentStatus.CANCELLED) {
    message = `Shipment can only be cancelled before it is picked up (current status: ${from})`;
  } else if (
    from === ShipmentStatus.FAILED_DELIVERY &&
    toStatus === ShipmentStatus.OUT_FOR_DELIVERY &&
    s.failedAttempts >= MAX_DELIVERY_ATTEMPTS
  ) {
    message = `Maximum of ${MAX_DELIVERY_ATTEMPTS} delivery attempts reached; the shipment can only be RETURNED`;
  }
  const next = getAllowedNextStatuses(from, s.failedAttempts, role);
  return badRequest(message, [
    {
      path: "body.status",
      message: next.length > 0 ? `Allowed next statuses for your role: ${next.join(", ")}` : `No status changes are available to your role from ${from}`,
    },
  ]);
};

/**
 * THE single entry point for shipment status changes. In one transaction:
 * 1. read the shipment within the caller's scope (404 otherwise),
 * 2. check the endpoint precondition, the TRANSITIONS map (400 with allowed
 *    next statuses), the role (403) and the payment gate (409),
 * 3. apply the per-status effects (timestamps, currentHubId, attempt counter),
 * 4. guarded update `WHERE id AND status = <from> [AND guard]`: if a concurrent
 *    request changed the row first, 0 rows match and we return 409,
 * 5. side effects (pickup request, courier earning), status history, audit log,
 *    notification rows. Their emails are sent only after the commit.
 */
const changeStatus = async (input: ChangeStatusInput): Promise<ShipmentDetail> => {
  const { id, emails } = await prisma.$transaction(async (tx) => {
    const { actor, toStatus } = input;
    const s = await tx.shipment.findFirst({
      where: { id: input.shipmentId, deletedAt: null, ...scopeWhere(actor) },
      select: statusSnapshotSelect,
    });
    if (!s) throw notFound();
    const from = s.status;

    if (input.requireFrom && !input.requireFrom.includes(from)) {
      throw badRequest(`This action requires status ${input.requireFrom.join(" or ")} (current status: ${from})`, [
        { path: "status", message: `Current status is ${from}` },
      ]);
    }
    if (!isTransitionLegal(from, toStatus, s.failedAttempts)) throw illegalTransition(s, toStatus, actor.role);
    if (!canRoleTransition(from, toStatus, actor.role)) {
      throw new ApiError(httpStatus.FORBIDDEN, `Your role cannot change status from ${from} to ${toStatus}`);
    }
    if (
      from === ShipmentStatus.PENDING &&
      toStatus !== ShipmentStatus.CANCELLED &&
      s.paymentStatus !== ShipmentPaymentStatus.PAID
    ) {
      throw conflict("Shipment must be paid before it can move past PENDING");
    }

    // Per-status effects.
    const now = new Date();
    const effects: Prisma.ShipmentUncheckedUpdateManyInput = {};
    const auditExtra: Record<string, unknown> = {};
    let historyHubId: string | null = null;
    switch (toStatus) {
      case ShipmentStatus.PICKED_UP:
        effects.pickedUpAt = now;
        effects.currentHubId = null;
        break;
      case ShipmentStatus.AT_ORIGIN_HUB:
      case ShipmentStatus.AT_DESTINATION_HUB:
        historyHubId = await resolveHub(tx, s, toStatus, input.hubId);
        effects.currentHubId = historyHubId;
        auditExtra["hubId"] = historyHubId;
        break;
      case ShipmentStatus.IN_TRANSIT:
      case ShipmentStatus.OUT_FOR_DELIVERY:
      case ShipmentStatus.RETURNED:
        effects.currentHubId = null;
        break;
      case ShipmentStatus.FAILED_DELIVERY:
        if (!input.note) throw badRequest("A reason (note) is required for FAILED_DELIVERY", [{ path: "body.note", message: "Required" }]);
        effects.failedAttempts = { increment: 1 };
        effects.failureReason = input.note;
        auditExtra["failedAttempts"] = s.failedAttempts + 1;
        break;
      case ShipmentStatus.DELIVERED:
        if (!s.courierId) throw conflict("Shipment has no assigned courier");
        effects.deliveredAt = now;
        effects.currentHubId = null;
        break;
      default:
        break;
    }

    await input.beforeUpdate?.(tx, s);

    const { count } = await tx.shipment.updateMany({
      where: { id: s.id, status: from, deletedAt: null, ...input.guard },
      data: { ...input.data, ...effects, status: toStatus },
    });
    if (count === 0) throw conflict(input.guardMessage ?? "Shipment status changed concurrently, please retry");

    // Side effects that belong to the status itself.
    if (toStatus === ShipmentStatus.PICKED_UP) {
      await tx.pickupRequest.updateMany({
        where: { shipmentId: s.id, status: PickupStatus.SCHEDULED },
        data: { status: PickupStatus.COMPLETED, completedAt: now },
      });
    }
    if (toStatus === ShipmentStatus.CANCELLED) {
      await tx.pickupRequest.updateMany({
        where: { shipmentId: s.id, status: PickupStatus.SCHEDULED },
        data: { status: PickupStatus.CANCELLED },
      });
    }
    if (toStatus === ShipmentStatus.DELIVERED && s.courierId) {
      // Same transaction as the status change; shipmentId is unique, so at most one earning.
      const amount = calculateCourierEarning(s.price);
      await tx.courierEarning.create({ data: { courierId: s.courierId, shipmentId: s.id, amount }, select: { id: true } });
      auditExtra["courierEarning"] = amount;
    }
    await input.afterUpdate?.(tx, s);

    await tx.shipmentStatusHistory.create({
      data: {
        shipmentId: s.id,
        fromStatus: from,
        toStatus,
        note: input.note ?? null,
        hubId: historyHubId,
        changedById: actor.id,
      },
      select: { id: true },
    });
    await AuditService.log(tx, {
      actor,
      action: input.auditAction ?? AUDIT_ACTIONS.SHIPMENT_STATUS_CHANGED,
      entityType: AUDIT_ENTITIES.SHIPMENT,
      entityId: s.id,
      before: { status: from, courierId: s.courierId },
      after: { status: toStatus, note: input.note ?? null, ...input.data, ...auditExtra },
      meta: input.meta,
    });
    const emails = await NotificationService.forStatusChange(tx, s.id, toStatus);
    return { id: s.id, emails };
  });
  void NotificationService.sendAfterCommit(emails);
  return loadDetailAndInvalidate(id);
};

interface LockedCourier {
  zoneId: string;
  isAvailable: boolean;
  profileDeletedAt: Date | null;
  role: string;
  status: string;
  userDeletedAt: Date | null;
}

/**
 * Row-locks the courier's profile AND user rows (FOR UPDATE covers both joined
 * tables) for the rest of the assignment transaction, then re-checks eligibility.
 * A concurrent availability toggle or deactivation waits until we commit.
 */
const lockCourierForAssignment = async (db: Db, courierId: string, originZoneId: string): Promise<void> => {
  const rows = await db.$queryRaw<LockedCourier[]>`
    SELECT cp."zoneId", cp."isAvailable", cp."deletedAt" AS "profileDeletedAt",
           u."role"::text AS "role", u."status"::text AS "status", u."deletedAt" AS "userDeletedAt"
    FROM "courier_profiles" cp
    JOIN "users" u ON u."id" = cp."userId"
    WHERE cp."userId" = ${courierId}
    FOR UPDATE`;
  const courier = rows[0];
  if (!courier || courier.role !== Role.COURIER || courier.userDeletedAt || courier.profileDeletedAt) {
    throw badRequest("Courier not found", [{ path: "body.courierId", message: "No active courier with this id" }]);
  }
  if (courier.status !== UserStatus.ACTIVE) throw conflict("Courier account is not active");
  if (!courier.isAvailable) throw conflict("Courier is not available");
  if (courier.zoneId !== originZoneId) {
    throw badRequest("Courier does not operate in the shipment's origin zone", [
      { path: "body.courierId", message: "Courier zone does not match the origin zone" },
    ]);
  }
};

/** Customer (owner), PENDING + PAID only: stores the pickup window and moves to PICKUP_SCHEDULED. */
const schedulePickup = (actor: Actor, id: string, payload: PickupInput, meta: RequestMeta): Promise<ShipmentDetail> =>
  changeStatus({
    shipmentId: id,
    toStatus: ShipmentStatus.PICKUP_SCHEDULED,
    actor,
    meta,
    requireFrom: [ShipmentStatus.PENDING],
    note: payload.notes ?? "Pickup scheduled",
    auditAction: AUDIT_ACTIONS.SHIPMENT_PICKUP_SCHEDULED,
    afterUpdate: async (tx, s) => {
      const fields = {
        requestedById: actor.id,
        pickupAddress: payload.pickupAddress ?? s.pickupAddress,
        contactName: payload.contactName ?? s.senderName,
        contactPhone: payload.contactPhone ?? s.senderPhone,
        scheduledAt: payload.windowStart,
        scheduledUntil: payload.windowEnd,
        notes: payload.notes ?? null,
        status: PickupStatus.SCHEDULED,
        completedAt: null,
        deletedAt: null,
      };
      await tx.pickupRequest.upsert({
        where: { shipmentId: s.id },
        create: { shipmentId: s.id, ...fields },
        update: fields,
        select: { id: true },
      });
    },
  });

/**
 * Admin: PICKUP_SCHEDULED → COURIER_ASSIGNED. Double-assignment is prevented by
 * (1) the courier row lock + re-check and (2) the guarded update
 * `WHERE status = PICKUP_SCHEDULED AND courierId IS NULL`: of two concurrent
 * assigns, the second waits for the first's row lock, then matches 0 rows → 409.
 */
const assignCourier = (actor: Actor, id: string, payload: AssignInput, meta: RequestMeta): Promise<ShipmentDetail> =>
  changeStatus({
    shipmentId: id,
    toStatus: ShipmentStatus.COURIER_ASSIGNED,
    actor,
    meta,
    requireFrom: [ShipmentStatus.PICKUP_SCHEDULED],
    note: payload.note ?? "Courier assigned",
    data: { courierId: payload.courierId },
    guard: { courierId: null },
    guardMessage: "Shipment was assigned concurrently, please refresh",
    auditAction: AUDIT_ACTIONS.SHIPMENT_ASSIGNED,
    beforeUpdate: (tx, s) => lockCourierForAssignment(tx, payload.courierId, s.originZoneId),
  });

/** Admin, before PICKED_UP: COURIER_ASSIGNED → PICKUP_SCHEDULED and clears the courier. */
const unassignCourier = (actor: Actor, id: string, payload: UnassignInput, meta: RequestMeta): Promise<ShipmentDetail> =>
  changeStatus({
    shipmentId: id,
    toStatus: ShipmentStatus.PICKUP_SCHEDULED,
    actor,
    meta,
    requireFrom: [ShipmentStatus.COURIER_ASSIGNED],
    note: payload?.note ?? "Courier unassigned",
    data: { courierId: null },
    auditAction: AUDIT_ACTIONS.SHIPMENT_UNASSIGNED,
  });

/** PATCH /status for courier and admin; role rules come from TRANSITIONS. */
const updateStatus = (actor: Actor, id: string, payload: UpdateStatusInput, meta: RequestMeta): Promise<ShipmentDetail> =>
  changeStatus({
    shipmentId: id,
    toStatus: payload.status,
    actor,
    meta,
    note: payload.note ?? null,
    hubId: payload.hubId ?? null,
  });

const create = async (actor: Actor, payload: CreateShipmentInput, meta: RequestMeta): Promise<ShipmentDetail> => {
  // Retries the whole transaction only on a trackingId collision (see withTrackingIdRetry).
  const { id, emails } = await withTrackingIdRetry((trackingId) =>
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
          weightLb: payload.weightLb,
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
      return { id: shipment.id, emails: await NotificationService.forShipmentCreated(tx, shipment.id) };
    }),
  );
  void NotificationService.sendAfterCommit(emails);
  return loadDetailAndInvalidate(id);
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
  return toDetail(shipment);
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

    const weightChanged = payload.weightLb !== undefined && !existing.weightLb.equals(payload.weightLb);
    const serviceChanged = payload.serviceType !== undefined && payload.serviceType !== existing.serviceType;
    const repriced = weightChanged || serviceChanged;

    if (repriced && existing.paymentStatus === ShipmentPaymentStatus.PAID) {
      throw conflict("Weight and service type cannot be changed after payment", [
        ...(weightChanged ? [{ path: "body.weightLb", message: "Locked after payment" }] : []),
        ...(serviceChanged ? [{ path: "body.serviceType", message: "Locked after payment" }] : []),
      ]);
    }

    if (repriced && (await PaymentService.hasOpenPayment(tx, id))) {
      throw conflict("A checkout for this shipment is open; wait for it to complete or expire before changing weight or service type");
    }

    const data: Prisma.ShipmentUpdateManyMutationInput = { ...payload };
    if (repriced) {
      const snapshot = await PricingService.quote(tx, {
        serviceType: payload.serviceType ?? existing.serviceType,
        weightLb: payload.weightLb ?? existing.weightLb.toNumber(),
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
  return loadDetailAndInvalidate(id);
};

/**
 * Owner (customer) or admin, before PICKED_UP. For a PAID shipment:
 * 1. the cancel transaction also moves the Payment to REFUND_PENDING (the refund
 *    obligation commits atomically with the cancellation), then
 * 2. after commit the Stripe refund runs with a fixed idempotency key. If Stripe
 *    fails, the shipment stays cancelled and the payment stays REFUND_PENDING with
 *    requiresReview (retry: POST /admin/payments/:id/refund, or charge.refunded).
 */
const cancel = async (actor: Actor, id: string, reason: string | undefined, meta: RequestMeta): Promise<ShipmentDetail> => {
  const refund: { paymentId: string | null } = { paymentId: null };
  await changeStatus({
    shipmentId: id,
    toStatus: ShipmentStatus.CANCELLED,
    actor,
    meta,
    note: reason ?? "Cancelled",
    data: { cancelledAt: new Date(), cancelReason: reason ?? null },
    afterUpdate: async (tx) => {
      refund.paymentId = await PaymentService.markRefundPendingForCancel(tx, id, actor, meta);
    },
  });
  if (refund.paymentId) await PaymentService.processRefund(refund.paymentId, actor);
  return loadDetailAndInvalidate(id);
};

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
  }).then(async (result) => {
    await cache.invalidate(CACHE_KEYS.tracking(result.trackingId));
    return result;
  });

/** Statuses in which the assigned courier may upload (or replace) the proof of delivery. */
const PROOF_STATUSES: ShipmentStatus[] = [ShipmentStatus.OUT_FOR_DELIVERY, ShipmentStatus.DELIVERED];

/**
 * Assigned courier only. Order matters:
 * 1. cheap checks first (404 outside scope, 409 wrong status) so a bad request never uploads;
 * 2. stream the in-memory image to Cloudinary (outside the transaction: no DB lock held during I/O);
 * 3. row-lock, re-check courier + status, store url/publicId, audit, in one transaction;
 *    if that fails, the just-uploaded image is deleted;
 * 4. after commit, the replaced image (if any) is deleted from Cloudinary.
 */
const uploadProof = async (actor: Actor, id: string, image: Buffer, meta: RequestMeta): Promise<ShipmentDetail> => {
  const where: Prisma.ShipmentWhereInput = { id, deletedAt: null, courierId: actor.id };
  const current = await prisma.shipment.findFirst({ where, select: { status: true } });
  if (!current) throw notFound();
  if (!PROOF_STATUSES.includes(current.status)) {
    throw conflict(`Proof of delivery can only be uploaded when the shipment is OUT_FOR_DELIVERY or DELIVERED (current status: ${current.status})`);
  }

  let uploaded;
  try {
    uploaded = await uploadImageBuffer(image, { folder: PROOF_FOLDER, tags: ["proof-of-delivery", `shipment-${id}`] });
  } catch (error) {
    console.warn(`[proof] Cloudinary upload failed for shipment ${id}: ${error instanceof Error ? error.message : "unknown error"}`);
    throw new ApiError(httpStatus.BAD_GATEWAY, "Image upload failed, please try again");
  }

  let replacedPublicId: string | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "shipments" WHERE "id" = ${id} FOR UPDATE`;
      const locked = await tx.shipment.findFirst({
        where,
        select: { status: true, proofOfDeliveryUrl: true, proofOfDeliveryPublicId: true },
      });
      if (!locked) throw notFound();
      if (!PROOF_STATUSES.includes(locked.status)) throw conflict(`Shipment status changed to ${locked.status}, please retry`);
      replacedPublicId = locked.proofOfDeliveryPublicId;
      const uploadedAt = new Date();
      await tx.shipment.update({
        where: { id },
        data: { proofOfDeliveryUrl: uploaded.url, proofOfDeliveryPublicId: uploaded.publicId, proofOfDeliveryUploadedAt: uploadedAt },
        select: { id: true },
      });
      await AuditService.log(tx, {
        actor,
        action: AUDIT_ACTIONS.SHIPMENT_PROOF_UPLOADED,
        entityType: AUDIT_ENTITIES.SHIPMENT,
        entityId: id,
        before: { proofOfDeliveryPublicId: locked.proofOfDeliveryPublicId },
        after: {
          proofOfDeliveryPublicId: uploaded.publicId,
          status: locked.status,
          bytes: uploaded.bytes,
          format: uploaded.format,
          replaced: locked.proofOfDeliveryPublicId !== null,
        },
        meta,
      });
    });
  } catch (error) {
    await deleteImage(uploaded.publicId);
    throw error;
  }

  if (replacedPublicId && replacedPublicId !== uploaded.publicId) await deleteImage(replacedPublicId);
  return loadDetailAndInvalidate(id);
};

export const ShipmentService = {
  uploadProof,
  changeStatus,
  create,
  list,
  getById,
  update,
  cancel,
  remove,
  schedulePickup,
  assignCourier,
  unassignCourier,
  updateStatus,
};
