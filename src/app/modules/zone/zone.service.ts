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
import { zoneSelect, type ZoneDto } from "./zone.types.js";
import type { CreateZoneInput, UpdateZoneInput, ZoneListQuery } from "./zone.validation.js";

const notFound = (): ApiError => new ApiError(httpStatus.NOT_FOUND, "Zone not found");

const findExisting = async (db: Prisma.TransactionClient, id: string): Promise<ZoneDto> => {
  const zone = await db.zone.findFirst({ where: { id, deletedAt: null }, select: zoneSelect });
  if (!zone) throw notFound();
  return zone;
};

const list = async (query: ZoneListQuery): Promise<Paginated<ZoneDto>> => {
  const where: Prisma.ZoneWhereInput = {
    deletedAt: null,
    ...(query.isActive === "all" ? {} : { isActive: query.isActive }),
    ...(query.searchTerm
      ? {
          OR: [
            { name: { contains: query.searchTerm, mode: "insensitive" } },
            { code: { contains: query.searchTerm, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  // Two independent reads (a batch transaction adds no consistency under READ COMMITTED,
  // and with many relations it makes Prisma overlap queries on one connection).
  const [data, total] = await Promise.all([
    prisma.zone.findMany({
      where,
      select: zoneSelect,
      orderBy: buildOrderBy(query.sortBy, query.sortOrder),
      ...getSkipTake(query),
    }),
    prisma.zone.count({ where }),
  ]);
  return { data, meta: buildMeta(query, total) };
};

const getById = (id: string): Promise<ZoneDto> => findExisting(prisma, id);

const create = (payload: CreateZoneInput, actor: Actor, meta: RequestMeta): Promise<ZoneDto> =>
  prisma.$transaction(async (tx) => {
    const zone = await tx.zone.create({
      data: {
        name: payload.name,
        code: payload.code,
        description: payload.description ?? null,
        ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
      },
      select: zoneSelect,
    });
    await AuditService.log(tx, {
      actor,
      action: AUDIT_ACTIONS.ZONE_CREATED,
      entityType: AUDIT_ENTITIES.ZONE,
      entityId: zone.id,
      after: zone,
      meta,
    });
    return zone;
  });

const update = (id: string, payload: UpdateZoneInput, actor: Actor, meta: RequestMeta): Promise<ZoneDto> =>
  prisma.$transaction(async (tx) => {
    const before = await findExisting(tx, id);
    const zone = await tx.zone.update({
      where: { id },
      data: {
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.code !== undefined ? { code: payload.code } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
      },
      select: zoneSelect,
    });
    await AuditService.log(tx, {
      actor,
      action: AUDIT_ACTIONS.ZONE_UPDATED,
      entityType: AUDIT_ENTITIES.ZONE,
      entityId: id,
      before,
      after: zone,
      meta,
    });
    return zone;
  });

/** Active = not soft-deleted (hubs, couriers) or not deleted and not finished (shipments). */
const getUsage = async (db: Prisma.TransactionClient, zoneId: string): Promise<ErrorDetail[]> => {
  // Sequential on purpose: queries inside an interactive transaction share one connection.
  const hubs = await db.hub.count({ where: { zoneId, deletedAt: null } });
  const couriers = await db.courierProfile.count({ where: { zoneId, deletedAt: null } });
  const shipments = await db.shipment.count({
    where: {
      deletedAt: null,
      status: { notIn: [...TERMINAL_STATUSES] },
      OR: [{ originZoneId: zoneId }, { destinationZoneId: zoneId }],
    },
  });
  const usage: ErrorDetail[] = [];
  if (hubs > 0) usage.push({ path: "hubs", message: `${hubs} hub(s) still belong to this zone` });
  if (couriers > 0) usage.push({ path: "couriers", message: `${couriers} courier(s) still operate in this zone` });
  if (shipments > 0) usage.push({ path: "shipments", message: `${shipments} active shipment(s) use this zone` });
  return usage;
};

const remove = (id: string, actor: Actor, meta: RequestMeta): Promise<ZoneDto> =>
  prisma.$transaction(async (tx) => {
    const before = await findExisting(tx, id);
    const usage = await getUsage(tx, id);
    if (usage.length > 0) {
      throw new ApiError(httpStatus.CONFLICT, "Zone is still in use and cannot be deleted", usage);
    }
    const zone = await tx.zone.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
      select: zoneSelect,
    });
    await AuditService.log(tx, {
      actor,
      action: AUDIT_ACTIONS.ZONE_DELETED,
      entityType: AUDIT_ENTITIES.ZONE,
      entityId: id,
      before,
      meta,
    });
    return zone;
  });

export const ZoneService = { list, getById, create, update, remove };
