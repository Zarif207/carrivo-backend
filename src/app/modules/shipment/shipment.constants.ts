import { Role, ShipmentStatus } from "../../../generated/prisma/enums.js";

const { CUSTOMER, COURIER, ADMIN } = Role;

/**
 * THE shipment state machine: TRANSITIONS[from][to] = roles allowed to make that move.
 * Every status change goes through ShipmentService.changeStatus, which checks this map.
 * Ownership is checked separately (customer owns it, courier is assigned to it).
 */
export const TRANSITIONS: Record<ShipmentStatus, Partial<Record<ShipmentStatus, readonly Role[]>>> = {
  PENDING: {
    PICKUP_SCHEDULED: [CUSTOMER], // POST /shipments/:id/pickup (payment gate applies)
    CANCELLED: [CUSTOMER, ADMIN],
  },
  PICKUP_SCHEDULED: {
    COURIER_ASSIGNED: [ADMIN], // POST /shipments/:id/assign
    CANCELLED: [CUSTOMER, ADMIN],
  },
  COURIER_ASSIGNED: {
    PICKED_UP: [COURIER],
    PICKUP_SCHEDULED: [ADMIN], // POST /shipments/:id/unassign
    CANCELLED: [CUSTOMER, ADMIN],
  },
  PICKED_UP: { AT_ORIGIN_HUB: [ADMIN] },
  AT_ORIGIN_HUB: { IN_TRANSIT: [ADMIN] },
  IN_TRANSIT: { AT_DESTINATION_HUB: [ADMIN] },
  AT_DESTINATION_HUB: { OUT_FOR_DELIVERY: [ADMIN] },
  OUT_FOR_DELIVERY: { DELIVERED: [COURIER], FAILED_DELIVERY: [COURIER] },
  FAILED_DELIVERY: {
    OUT_FOR_DELIVERY: [COURIER], // retry; blocked after MAX_DELIVERY_ATTEMPTS
    RETURNED: [ADMIN],
  },
  DELIVERED: {},
  RETURNED: {},
  CANCELLED: {},
};

/** After this many failed attempts, only RETURNED is allowed. */
export const MAX_DELIVERY_ATTEMPTS = 3;

const ALL_STATUSES = Object.keys(TRANSITIONS) as ShipmentStatus[];

/** Next statuses reachable from `from` (derived from TRANSITIONS; used by the seed too). */
export const allowedTransitions = {} as Record<ShipmentStatus, readonly ShipmentStatus[]>;
for (const from of ALL_STATUSES) {
  allowedTransitions[from] = Object.keys(TRANSITIONS[from]) as ShipmentStatus[];
}

/** Is `from → to` a legal move at all, given the failed-attempt count? */
export const isTransitionLegal = (from: ShipmentStatus, to: ShipmentStatus, failedAttempts: number): boolean => {
  if (!(to in TRANSITIONS[from])) return false;
  if (from === ShipmentStatus.FAILED_DELIVERY && to === ShipmentStatus.OUT_FOR_DELIVERY) {
    return failedAttempts < MAX_DELIVERY_ATTEMPTS;
  }
  return true;
};

export const canRoleTransition = (from: ShipmentStatus, to: ShipmentStatus, role: Role): boolean =>
  TRANSITIONS[from][to]?.includes(role) ?? false;

/** Legal next statuses; pass a role to keep only the ones that role may make. */
export const getAllowedNextStatuses = (
  from: ShipmentStatus,
  failedAttempts: number,
  role?: Role,
): ShipmentStatus[] =>
  allowedTransitions[from].filter(
    (to) => isTransitionLegal(from, to, failedAttempts) && (role === undefined || canRoleTransition(from, to, role)),
  );

/** Targets accepted by PATCH /shipments/:id/status. The others have their own endpoints. */
export const STATUS_ENDPOINT_TARGETS = [
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.AT_ORIGIN_HUB,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.AT_DESTINATION_HUB,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.DELIVERED,
  ShipmentStatus.FAILED_DELIVERY,
  ShipmentStatus.RETURNED,
] as const;

/** Statuses that place the parcel at a hub (they set currentHubId). */
export const HUB_STATUSES: readonly ShipmentStatus[] = [ShipmentStatus.AT_ORIGIN_HUB, ShipmentStatus.AT_DESTINATION_HUB];

export const TERMINAL_STATUSES: readonly ShipmentStatus[] = [
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RETURNED,
  ShipmentStatus.CANCELLED,
];

/** "Before PICKED_UP" (also enforced by TRANSITIONS). */
export const CANCELLABLE_STATUSES: readonly ShipmentStatus[] = [
  ShipmentStatus.PENDING,
  ShipmentStatus.PICKUP_SCHEDULED,
  ShipmentStatus.COURIER_ASSIGNED,
];

/** Admin soft delete is limited to shipments that are not moving. */
export const ADMIN_DELETABLE_STATUSES: readonly ShipmentStatus[] = [ShipmentStatus.PENDING, ...TERMINAL_STATUSES];

export const SHIPMENT_SORT_FIELDS = ["createdAt", "updatedAt", "price", "weightLb", "status", "trackingId"] as const;

/** Pickup window rules for POST /shipments/:id/pickup. */
export const PICKUP_MAX_WINDOW_HOURS = 12;
export const PICKUP_MAX_DAYS_AHEAD = 30;

export const TRACKING_ID_PREFIX = "CRV";
export const TRACKING_ID_PATTERN = /^CRV-\d{6}-[A-Z0-9]{6}$/;
export const TRACKING_ID_MAX_ATTEMPTS = 5;

/** Business time zone (US Eastern, with daylight saving) for tracking-id dates and date-only filters. */
export { BUSINESS_TIMEZONE } from "../../utils/timezone.js";
