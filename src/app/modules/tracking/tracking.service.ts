import httpStatus from "http-status";
import { CACHE_KEYS, CACHE_TTL, cache } from "../../lib/cache.js";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../utils/ApiError.js";
import { trackingSelect, type PublicTracking } from "./tracking.types.js";

/** Public lookup by tracking id (already upper-cased by validation; unique index). */
const load = async (trackingId: string): Promise<PublicTracking> => {
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

/** Cached 15 s; every shipment write deletes this key after it commits. */
const track = (trackingId: string): Promise<PublicTracking> =>
  cache.getOrLoad(CACHE_KEYS.tracking(trackingId), CACHE_TTL.tracking, () => load(trackingId));

export const TrackingService = { track };
