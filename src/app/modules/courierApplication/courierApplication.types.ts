import type { Prisma } from "../../../generated/prisma/client.js";

/** What the applicant sees about their own application (never the reviewer's identity). */
export const myApplicationSelect = {
  id: true,
  status: true,
  phone: true,
  vehicleType: true,
  vehiclePlate: true,
  availability: true,
  experience: true,
  about: true,
  reviewNote: true,
  reviewedAt: true,
  createdAt: true,
  updatedAt: true,
  preferredZone: { select: { id: true, name: true, code: true } },
} as const satisfies Prisma.CourierApplicationSelect;

/** Staff view: the applicant's account and who decided. */
export const adminApplicationSelect = {
  ...myApplicationSelect,
  user: { select: { id: true, name: true, email: true, phone: true, role: true, status: true } },
  reviewedBy: { select: { id: true, name: true } },
} as const satisfies Prisma.CourierApplicationSelect;

export type MyApplication = Prisma.CourierApplicationGetPayload<{ select: typeof myApplicationSelect }>;
export type AdminApplication = Prisma.CourierApplicationGetPayload<{ select: typeof adminApplicationSelect }>;

/** GET /courier-applications/my */
export interface MyApplications {
  /** Newest application, or null if the caller never applied. */
  latest: MyApplication | null;
  /** Every application, newest first (latest included), capped at MY_HISTORY_LIMIT. */
  history: MyApplication[];
  canApply: boolean;
  /** ISO date-time while a rejection cooldown runs, else null. */
  canReapplyAt: Date | null;
  /** Why the caller can't apply right now (null when canApply). */
  blockedReason: string | null;
  cooldownDays: number;
}
