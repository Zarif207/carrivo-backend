import { Role, ShipmentStatus } from "../../../generated/prisma/enums.js";

/**
 * THE shipment state machine. Every status change goes through
 * ShipmentService.changeStatus, which checks this map.
 */
export const allowedTransitions: Record<ShipmentStatus, readonly ShipmentStatus[]> = {
  PENDING: [ShipmentStatus.PICKUP_SCHEDULED, ShipmentStatus.CANCELLED],
  PICKUP_SCHEDULED: [ShipmentStatus.COURIER_ASSIGNED, ShipmentStatus.CANCELLED],
  COURIER_ASSIGNED: [ShipmentStatus.PICKED_UP, ShipmentStatus.CANCELLED],
  PICKED_UP: [ShipmentStatus.AT_ORIGIN_HUB],
  AT_ORIGIN_HUB: [ShipmentStatus.IN_TRANSIT],
  IN_TRANSIT: [ShipmentStatus.AT_DESTINATION_HUB],
  AT_DESTINATION_HUB: [ShipmentStatus.OUT_FOR_DELIVERY],
  OUT_FOR_DELIVERY: [ShipmentStatus.DELIVERED, ShipmentStatus.FAILED_DELIVERY],
  FAILED_DELIVERY: [ShipmentStatus.OUT_FOR_DELIVERY, ShipmentStatus.RETURNED],
  DELIVERED: [],
  RETURNED: [],
  CANCELLED: [],
};

/**
 * Which roles may move a shipment INTO a status. Ownership (customer owns it,
 * courier is assigned to it) is checked separately by changeStatus.
 * Phase 3 only enables cancellation; Phase 4 adds the courier/admin transitions.
 */
export const transitionRoles: Partial<Record<ShipmentStatus, readonly Role[]>> = {
  CANCELLED: [Role.CUSTOMER, Role.ADMIN],
};

export const TERMINAL_STATUSES: readonly ShipmentStatus[] = [
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RETURNED,
  ShipmentStatus.CANCELLED,
];

/** "Before PICKED_UP" (also enforced by allowedTransitions). */
export const CANCELLABLE_STATUSES: readonly ShipmentStatus[] = [
  ShipmentStatus.PENDING,
  ShipmentStatus.PICKUP_SCHEDULED,
  ShipmentStatus.COURIER_ASSIGNED,
];

/** Admin soft delete is limited to shipments that are not moving. */
export const ADMIN_DELETABLE_STATUSES: readonly ShipmentStatus[] = [ShipmentStatus.PENDING, ...TERMINAL_STATUSES];

export const SHIPMENT_SORT_FIELDS = ["createdAt", "updatedAt", "price", "weightKg", "status", "trackingId"] as const;

export const TRACKING_ID_PREFIX = "CRV";
export const TRACKING_ID_PATTERN = /^CRV-\d{6}-[A-Z0-9]{6}$/;
export const TRACKING_ID_MAX_ATTEMPTS = 5;

/** Business timezone for tracking-id dates and date-only list filters (UTC+6, no DST). */
export const BUSINESS_TIMEZONE = "Asia/Dhaka";
export const BUSINESS_UTC_OFFSET = "+06:00";
