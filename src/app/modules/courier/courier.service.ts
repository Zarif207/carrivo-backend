import httpStatus from "http-status";
import { Prisma } from "../../../generated/prisma/client.js";
import { EarningStatus, Role, UserStatus } from "../../../generated/prisma/enums.js";
import { prisma } from "../../lib/prisma.js";
import type { PaginationMeta } from "../../types/response.types.js";
import { ApiError } from "../../utils/ApiError.js";
import { formatMoney, formatMoneyFields } from "../../utils/money.js";
import { buildMeta, buildOrderBy, getSkipTake, type Paginated } from "../../utils/pagination.js";
import type { RequestMeta } from "../../utils/requestMeta.js";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../audit/audit.constants.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor } from "../audit/audit.types.js";
import { TERMINAL_STATUSES } from "../shipment/shipment.constants.js";
import {
  courierProfileSelect,
  courierTaskSelect,
  earningSelect,
  type CourierListItem,
  type CourierProfileDto,
  type CourierTask,
  type EarningItem,
  type EarningsResult,
} from "./courier.types.js";
import type {
  AvailabilityInput,
  CourierEarningQuery,
  CourierListQuery,
  CourierTaskQuery,
} from "./courier.validation.js";

const activeShipmentWhere: Prisma.ShipmentWhereInput = {
  deletedAt: null,
  status: { notIn: [...TERMINAL_STATUSES] },
};

/** Admin: active, non-deleted couriers with their profile and current active task count. */
const list = async (query: CourierListQuery): Promise<Paginated<CourierListItem>> => {
  const where: Prisma.UserWhereInput = {
    role: Role.COURIER,
    status: UserStatus.ACTIVE,
    deletedAt: null,
    courierProfile: {
      is: {
        deletedAt: null,
        ...(query.zoneId ? { zoneId: query.zoneId } : {}),
        ...(query.hubId ? { hubId: query.hubId } : {}),
        ...(query.available !== undefined ? { isAvailable: query.available } : {}),
      },
    },
    ...(query.searchTerm
      ? {
          OR: [
            { name: { contains: query.searchTerm, mode: "insensitive" } },
            { email: { contains: query.searchTerm, mode: "insensitive" } },
            { phone: { contains: query.searchTerm, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        courierProfile: { select: courierProfileSelect },
        _count: { select: { assignedShipments: { where: activeShipmentWhere } } },
      },
      orderBy: buildOrderBy(query.sortBy, query.sortOrder),
      ...getSkipTake(query),
    }),
    prisma.user.count({ where }),
  ]);
  const data = rows.map(({ _count, ...user }) => ({ ...user, activeTaskCount: _count.assignedShipments }));
  return { data, meta: buildMeta(query, total) };
};

/** Courier: shipments assigned to me. No status filter → active tasks only. */
const myTasks = async (actor: Actor, query: CourierTaskQuery): Promise<Paginated<CourierTask>> => {
  const where: Prisma.ShipmentWhereInput = {
    courierId: actor.id,
    deletedAt: null,
    status: query.status ?? { notIn: [...TERMINAL_STATUSES] },
    ...(query.searchTerm
      ? {
          OR: [
            { trackingId: { contains: query.searchTerm, mode: "insensitive" } },
            { receiverName: { contains: query.searchTerm, mode: "insensitive" } },
            { receiverPhone: { contains: query.searchTerm, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.shipment.findMany({
      where,
      select: courierTaskSelect,
      orderBy: buildOrderBy(query.sortBy, query.sortOrder),
      ...getSkipTake(query),
    }),
    prisma.shipment.count({ where }),
  ]);
  return { data: rows.map((row) => formatMoneyFields(row, ["price"])), meta: buildMeta(query, total) };
};

/**
 * Courier: summary + paginated list. The summary covers the same date range as
 * the list (but all statuses), so pending vs paid-out stays visible when filtering.
 */
const myEarnings = async (
  actor: Actor,
  query: CourierEarningQuery,
): Promise<{ data: EarningsResult; meta: PaginationMeta }> => {
  const range: Prisma.CourierEarningWhereInput = {
    courierId: actor.id,
    ...(query.fromDate || query.toDate
      ? {
          createdAt: {
            ...(query.fromDate ? { gte: query.fromDate } : {}),
            ...(query.toDate ? { lte: query.toDate } : {}),
          },
        }
      : {}),
  };
  const where: Prisma.CourierEarningWhereInput = { ...range, ...(query.status ? { status: query.status } : {}) };

  const [rows, total, groups] = await Promise.all([
    prisma.courierEarning.findMany({
      where,
      select: earningSelect,
      orderBy: buildOrderBy(query.sortBy, query.sortOrder),
      ...getSkipTake(query),
    }),
    prisma.courierEarning.count({ where }),
    prisma.courierEarning.groupBy({ by: ["status"], where: range, _sum: { amount: true }, _count: { _all: true } }),
  ]);

  const sumOf = (status: EarningStatus): Prisma.Decimal =>
    groups.find((g) => g.status === status)?._sum.amount ?? new Prisma.Decimal(0);
  const pending = sumOf(EarningStatus.PENDING);
  const paidOut = sumOf(EarningStatus.PAID);

  const earnings: EarningItem[] = rows.map((row) => ({
    ...row,
    amount: formatMoney(row.amount),
    shipment: { ...row.shipment, price: formatMoney(row.shipment.price) },
  }));
  return {
    data: {
      summary: {
        totalEarned: formatMoney(pending.plus(paidOut)),
        pending: formatMoney(pending),
        paidOut: formatMoney(paidOut),
        deliveries: groups.reduce((n, g) => n + g._count._all, 0),
      },
      earnings,
    },
    meta: buildMeta(query, total),
  };
};

/**
 * Courier: toggle availability. A plain UPDATE takes the row lock that
 * assignment's `SELECT … FOR UPDATE` also takes, so the two serialize.
 */
const setAvailability = (actor: Actor, payload: AvailabilityInput, meta: RequestMeta): Promise<CourierProfileDto> =>
  prisma.$transaction(async (tx) => {
    const profile = await tx.courierProfile.findFirst({
      where: { userId: actor.id, deletedAt: null },
      select: { id: true, isAvailable: true },
    });
    if (!profile) throw new ApiError(httpStatus.NOT_FOUND, "Courier profile not found");
    const updated = await tx.courierProfile.update({
      where: { id: profile.id },
      data: { isAvailable: payload.isAvailable },
      select: courierProfileSelect,
    });
    await AuditService.log(tx, {
      actor,
      action: AUDIT_ACTIONS.COURIER_AVAILABILITY_CHANGED,
      entityType: AUDIT_ENTITIES.COURIER_PROFILE,
      entityId: profile.id,
      before: { isAvailable: profile.isAvailable },
      after: { isAvailable: payload.isAvailable },
      meta,
    });
    return updated;
  });

export const CourierService = { list, myTasks, myEarnings, setAvailability };
