import httpStatus from "http-status";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../utils/ApiError.js";
import { safeUserSelect, userProfileSelect, type SafeUser, type UserProfile } from "./user.types.js";
import type { UpdateMeInput } from "./user.validation.js";

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

/** Only whitelisted fields reach Prisma (enforced by the strict Zod schema). */
const updateMe = async (userId: string, payload: UpdateMeInput): Promise<UserProfile> => {
  const existing = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true },
  });
  if (!existing) throw notFound();

  return prisma.user.update({
    where: { id: userId },
    data: {
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.phone !== undefined ? { phone: payload.phone } : {}),
      ...(payload.address !== undefined ? { address: payload.address } : {}),
      ...(payload.image !== undefined ? { image: payload.image } : {}),
    },
    select: userProfileSelect,
  });
};

export const UserService = { getSafeUserById, getMe, updateMe };
