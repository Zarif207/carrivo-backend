import type { Prisma } from "../../../generated/prisma/client.js";

/** Columns that are safe to return for a user. Never includes accounts/sessions/password. */
export const safeUserSelect = {
  id: true,
  name: true,
  email: true,
  emailVerified: true,
  image: true,
  role: true,
  status: true,
  phone: true,
  address: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.UserSelect;

export const userProfileSelect = {
  ...safeUserSelect,
  courierProfile: {
    select: {
      id: true,
      vehicleType: true,
      vehicleNumber: true,
      isAvailable: true,
      zone: { select: { id: true, name: true, code: true } },
      hub: { select: { id: true, name: true, code: true } },
    },
  },
} as const satisfies Prisma.UserSelect;

export type SafeUser = Prisma.UserGetPayload<{ select: typeof safeUserSelect }>;
export type UserProfile = Prisma.UserGetPayload<{ select: typeof userProfileSelect }>;
