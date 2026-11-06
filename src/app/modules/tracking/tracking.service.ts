import httpStatus from "http-status";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../utils/ApiError.js";
import { trackingSelect, type PublicTracking } from "./tracking.types.js";

/** Public lookup by tracking id (already upper-cased by validation; unique index). */
const track = async (trackingId: string): Promise<PublicTracking> => {
  const row = await prisma.shipment.findFirst({
    where: { trackingId, deletedAt: null },
    select: trackingSelect,
  });
  if (!row) throw new ApiError(httpStatus.NOT_FOUND, "No shipment found with this tracking ID");

  return {
    trackingId: row.trackingId,
    status: row.status,
    serviceType: row.serviceType,
    // City from the hub; falls back to the zone name if no hub is set.
    origin: { city: row.originHub?.city ?? row.originZone.name },
    destination: { city: row.destinationHub?.city ?? row.destinationZone.name },
    createdAt: row.createdAt,
    estimatedDeliveryAt: row.estimatedDeliveryAt,
    deliveredAt: row.deliveredAt,
    timeline: row.statusHistory.map((event) => ({
      status: event.toStatus,
      city: event.hub?.city ?? null,
      at: event.createdAt,
    })),
  };
};

export const TrackingService = { track };
