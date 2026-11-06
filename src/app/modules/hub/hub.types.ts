import type { Prisma } from "../../../generated/prisma/client.js";
import { zoneRefSelect } from "../zone/zone.types.js";

export const hubSelect = {
  id: true,
  name: true,
  code: true,
  address: true,
  city: true,
  phone: true,
  isActive: true,
  zone: { select: zoneRefSelect },
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.HubSelect;

export type HubDto = Prisma.HubGetPayload<{ select: typeof hubSelect }>;

/** Compact hub reference embedded in shipments. */
export const hubRefSelect = { id: true, name: true, code: true, city: true } as const satisfies Prisma.HubSelect;
