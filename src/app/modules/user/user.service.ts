import httpStatus from "http-status";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../utils/ApiError.js";
import type { RequestMeta } from "../../utils/requestMeta.js";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../audit/audit.constants.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor } from "../audit/audit.types.js";
import { safeUserSelect, userProfileSelect, type SafeUser, type UserProfile } from "./user.types.js";
import type { UpdateMeInput } from "./user.validation.js";

/** The fields a user may change about themselves (audit before/after). */
const editableSelect = { name: true, phone: true, address: true, image: true } as const;

const notFound = (): ApiError => new ApiError(httpStatus.NOT_FOUND, "User not found");

const getSafeUserById = async (userId: string): Promise<SafeUser> => {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: safeUserSelect,
  });
  if (!user) throw notFound();
  return user;
};

const getMe = async (userId: string): Promise<UserProfile> => {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: userProfileSelect,
  });
  if (!user) throw notFound();
  return user;
};

/**
 * Only whitelisted fields reach Prisma (enforced by the strict Zod schema). The
 * update and its audit row (changed fields only, before/after) commit together.
 */
const updateMe = async (actor: Actor, payload: UpdateMeInput, meta: RequestMeta): Promise<UserProfile> => {
  // Scalar selects only inside the transaction (relation selects would run concurrent
  // queries on its single connection); the full profile is read after commit.
  await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findFirst({
      where: { id: actor.id, deletedAt: null },
      select: editableSelect,
    });
    if (!existing) throw notFound();

    const data = {
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.phone !== undefined ? { phone: payload.phone } : {}),
      ...(payload.address !== undefined ? { address: payload.address } : {}),
      ...(payload.image !== undefined ? { image: payload.image } : {}),
    };
    const updated = await tx.user.update({ where: { id: actor.id }, data, select: editableSelect });

    const changed = (Object.keys(data) as (keyof typeof data)[]).filter((key) => existing[key] !== updated[key]);
    if (changed.length > 0) {
      await AuditService.log(tx, {
        actor,
        action: AUDIT_ACTIONS.USER_PROFILE_UPDATED,
        entityType: AUDIT_ENTITIES.USER,
        entityId: actor.id,
        before: Object.fromEntries(changed.map((key) => [key, existing[key]])),
        after: Object.fromEntries(changed.map((key) => [key, updated[key]])),
        meta,
      });
    }
  });
  return getMe(actor.id);
};

export const UserService = { getSafeUserById, getMe, updateMe };
