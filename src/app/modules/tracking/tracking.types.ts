import type { Prisma } from "../../../generated/prisma/client.js";
import type { ServiceType, ShipmentStatus } from "../../../generated/prisma/enums.js";

/**
 * Only public columns are selected: no names, phones, addresses, ids, prices,
 * history notes or who made each change.
 */
export const trackingSelect = {
  trackingId: true,
  status: true,
  serviceType: true,
  createdAt: true,
  estimatedDeliveryAt: true,
  deliveredAt: true,
  originHub: { select: { city: true } },
  destinationHub: { select: { city: true } },
  originZone: { select: { name: true } },
  destinationZone: { select: { name: true } },
  statusHistory: {
    orderBy: { createdAt: "asc" },
    select: { toStatus: true, createdAt: true, hub: { select: { city: true } } },
  },
} as const satisfies Prisma.ShipmentSelect;

export type TrackingRow = Prisma.ShipmentGetPayload<{ select: typeof trackingSelect }>;

export interface TrackingEvent {
  status: ShipmentStatus;
  city: string | null;
  at: Date;
}

export interface PublicTracking {
  trackingId: string;
  status: ShipmentStatus;
  serviceType: ServiceType;
  origin: { city: string };
  destination: { city: string };
  createdAt: Date;
  estimatedDeliveryAt: Date | null;
  deliveredAt: Date | null;
  timeline: TrackingEvent[];
}
