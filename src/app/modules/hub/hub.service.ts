import httpStatus from "http-status";
import type { Prisma } from "../../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import type { ErrorDetail } from "../../types/response.types.js";
import { ApiError } from "../../utils/ApiError.js";
import { buildMeta, buildOrderBy, getSkipTake, type Paginated } from "../../utils/pagination.js";
import type { RequestMeta } from "../../utils/requestMeta.js";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../audit/audit.constants.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor } from "../audit/audit.types.js";
import { TERMINAL_STATUSES } from "../shipment/shipment.constants.js";
import { hubSelect, type HubDto } from "./hub.types.js";
import type { CreateHubInput, HubListQuery, UpdateHubInput } from "./hub.validation.js";

const notFound = (): ApiError => new ApiError(httpStatus.NOT_FOUND, "Hub not found");

const findExisting = async (db: Prisma.TransactionClient, id: string): Promise<HubDto> => {
  const hub = await db.hub.findFirst({ where: { id, deletedAt: null }, select: hubSelect });
  if (!hub) throw notFound();
  return hub;
};

const assertZoneUsable = async (db: Prisma.TransactionClient, zoneId: string): Promise<void> => {
  const zone = await db.zone.findFirst({ where: { id: zoneId, deletedAt: null, isActive: true }, select: { id: true } });
  if (!zone) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Zone not found or inactive", [
      { path: "body.zoneId", message: "Zone not found or inactive" },
    ]);
  }
};

const list = async (query: HubListQuery): Promise<Paginated<HubDto>> => {
  const where: Prisma.HubWhereInput = {
    deletedAt: null,
    ...(query.isActive === "all" ? {} : { isActive: query.isActive }),
    ...(query.zoneId ? { zoneId: query.zoneId } : {}),
    ...(query.city ? { city: { equals: query.city, mode: "insensitive" } } : {}),
    ...(query.searchTerm
      ? {
          OR: [
            { name: { contains: query.searchTerm, mode: "insensitive" } },
            { code: { contains: query.searchTerm, mode: "insensitive" } },
            { city: { contains: query.searchTerm, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  // Two independent reads (a batch transaction adds no consistency under READ COMMITTED,
  // and with many relations it makes Prisma overlap queries on one connection).
  const [data, total] = await Promise.all([
    prisma.hub.findMany({
      where,
      select: hubSelect,
      orderBy: buildOrderBy(query.sortBy, query.sortOrder),
      ...getSkipTake(query),
    }),
    prisma.hub.count({ where }),
  ]);
  return { data, meta: buildMeta(query, total) };
};

const getById = (id: string): Promise<HubDto> => findExisting(prisma, id);

/** Couriers (non-deleted profiles) and unfinished shipments that still point at the hub. */
const getUsage = async (db: Prisma.TransactionClient, hubId: string): Promise<ErrorDetail[]> => {
  // Sequential on purpose: queries inside an interactive transaction share one connection.
  const couriers = await db.courierProfile.count({ where: { hubId, deletedAt: null } });
  const shipments = await db.shipment.count({
    where: {
      deletedAt: null,
      status: { notIn: [...TERMINAL_STATUSES] },
      OR: [{ originHubId: hubId }, { destinationHubId: hubId }, { currentHubId: hubId }],
    },
  });
  const usage: ErrorDetail[] = [];
  if (couriers > 0) usage.push({ path: "couriers", message: `${couriers} courier(s) are based at this hub` });
  if (shipments > 0) usage.push({ path: "shipments", message: `${shipments} active shipment(s) use this hub` });
  return usage;
};

const create = (payload: CreateHubInput, actor: Actor, meta: RequestMeta): Promise<HubDto> =>
  prisma.$transaction(async (tx) => {
    await assertZoneUsable(tx, payload.zoneId);
    const hub = await tx.hub.create({
      data: {
        name: payload.name,
        code: payload.code,
        address: payload.address,
        city: payload.city,
        phone: payload.phone ?? null,
        zoneId: payload.zoneId,
        ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
      },
      select: hubSelect,
    });
    await AuditService.log(tx, {
      actor,
      action: AUDIT_ACTIONS.HUB_CREATED,
      entityType: AUDIT_ENTITIES.HUB,
      entityId: hub.id,
      after: hub,
      meta,
    });
    return hub;
  });

const update = (id: string, payload: UpdateHubInput, actor: Actor, meta: RequestMeta): Promise<HubDto> =>
  prisma.$transaction(async (tx) => {
    const before = await findExisting(tx, id);
    if (payload.zoneId !== undefined && payload.zoneId !== before.zone.id) {
      await assertZoneUsable(tx, payload.zoneId);
      // Moving a hub to another zone would break the hub/zone pairing of its shipments and couriers.
      const usage = await getUsage(tx, id);
      if (usage.length > 0) {
        throw new ApiError(httpStatus.CONFLICT, "Hub is in use; its zone cannot be changed", usage);
      }
    }
    const hub = await tx.hub.update({
      where: { id },
      data: {
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.code !== undefined ? { code: payload.code } : {}),
        ...(payload.address !== undefined ? { address: payload.address } : {}),
        ...(payload.city !== undefined ? { city: payload.city } : {}),
        ...(payload.phone !== undefined ? { phone: payload.phone } : {}),
        ...(payload.zoneId !== undefined ? { zoneId: payload.zoneId } : {}),
        ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
      },
      select: hubSelect,
    });
    await AuditService.log(tx, {
      actor,
      action: AUDIT_ACTIONS.HUB_UPDATED,
      entityType: AUDIT_ENTITIES.HUB,
      entityId: id,
      before,
      after: hub,
      meta,
    });
    return hub;
  });

const remove = (id: string, actor: Actor, meta: RequestMeta): Promise<HubDto> =>
  prisma.$transaction(async (tx) => {
    const before = await findExisting(tx, id);
    const usage = await getUsage(tx, id);
    if (usage.length > 0) {
      throw new ApiError(httpStatus.CONFLICT, "Hub is still in use and cannot be deleted", usage);
    }
    const hub = await tx.hub.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
      select: hubSelect,
    });
    await AuditService.log(tx, {
      actor,
      action: AUDIT_ACTIONS.HUB_DELETED,
      entityType: AUDIT_ENTITIES.HUB,
      entityId: id,
      before,
      meta,
    });
    return hub;
  });

export const HubService = { list, getById, create, update, remove };
