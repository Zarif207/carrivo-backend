import type { Prisma } from "../../../generated/prisma/client.js";

export const zoneSelect = {
  id: true,
  name: true,
  code: true,
  description: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ZoneSelect;

export type ZoneDto = Prisma.ZoneGetPayload<{ select: typeof zoneSelect }>;

/** Compact zone reference embedded in hubs, pricing rules and shipments. */
export const zoneRefSelect = { id: true, name: true, code: true } as const satisfies Prisma.ZoneSelect;
