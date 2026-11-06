import type { Prisma } from "../../../generated/prisma/client.js";
import type { ShipmentStatus } from "../../../generated/prisma/enums.js";
import type { AuditAction } from "../audit/audit.constants.js";
import type { WithMoney } from "../../utils/money.js";
import type { RequestMeta } from "../../utils/requestMeta.js";
import type { Actor } from "../audit/audit.types.js";
import { hubRefSelect } from "../hub/hub.types.js";
import { zoneRefSelect } from "../zone/zone.types.js";

const personRef = { select: { id: true, name: true } } as const;

/** Row shape for list endpoints. */
export const shipmentListSelect = {
  id: true,
  trackingId: true,
  status: true,
  paymentStatus: true,
  serviceType: true,
  senderName: true,
  receiverName: true,
  receiverPhone: true,
  pickupAddress: true,
  deliveryAddress: true,
  weightKg: true,
  price: true,
  currency: true,
  originZone: { select: zoneRefSelect },
  destinationZone: { select: zoneRefSelect },
  originHub: { select: hubRefSelect },
  destinationHub: { select: hubRefSelect },
  customer: personRef,
  courier: personRef,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ShipmentSelect;

export const pickupRequestSelect = {
  scheduledAt: true,
  scheduledUntil: true,
  pickupAddress: true,
  contactName: true,
  contactPhone: true,
  notes: true,
  status: true,
  completedAt: true,
} as const satisfies Prisma.PickupRequestSelect;

/** Full shape for detail / create / update / cancel responses. Never includes deletedAt. */
export const shipmentDetailSelect = {
  ...shipmentListSelect,
  senderPhone: true,
  receiverEmail: true,
  description: true,
  declaredValue: true,
  isFragile: true,
  priceBreakdown: true,
  failedAttempts: true,
  failureReason: true,
  cancelReason: true,
  proofOfDeliveryUrl: true,
  proofOfDeliveryUploadedAt: true,
  estimatedDeliveryAt: true,
  pickedUpAt: true,
  deliveredAt: true,
  cancelledAt: true,
  currentHub: { select: hubRefSelect },
  courier: { select: { id: true, name: true, phone: true } },
  pickupRequest: { select: pickupRequestSelect },
  statusHistory: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      fromStatus: true,
      toStatus: true,
      note: true,
      hub: { select: hubRefSelect },
      changedBy: { select: { id: true, name: true, role: true } },
      createdAt: true,
    },
  },
} as const satisfies Prisma.ShipmentSelect;

/** Rows as read from the DB (Decimal money). */
export type ShipmentListRow = Prisma.ShipmentGetPayload<{ select: typeof shipmentListSelect }>;
export type ShipmentDetailRow = Prisma.ShipmentGetPayload<{ select: typeof shipmentDetailSelect }>;

export const SHIPMENT_LIST_MONEY_FIELDS = ["price"] as const;
export const SHIPMENT_DETAIL_MONEY_FIELDS = ["price", "declaredValue"] as const;

/** API shapes: money fields as 2-decimal strings. (priceBreakdown is already stored that way.) */
export type ShipmentListItem = WithMoney<ShipmentListRow, (typeof SHIPMENT_LIST_MONEY_FIELDS)[number]>;
export type ShipmentDetail = WithMoney<ShipmentDetailRow, (typeof SHIPMENT_DETAIL_MONEY_FIELDS)[number]>;

/** What changeStatus reads (under its guard) and hands to hooks. */
export const statusSnapshotSelect = {
  id: true,
  trackingId: true,
  status: true,
  paymentStatus: true,
  failedAttempts: true,
  courierId: true,
  price: true,
  originZoneId: true,
  destinationZoneId: true,
  originHubId: true,
  destinationHubId: true,
  pickupAddress: true,
  senderName: true,
  senderPhone: true,
} as const satisfies Prisma.ShipmentSelect;

export type StatusSnapshot = Prisma.ShipmentGetPayload<{ select: typeof statusSnapshotSelect }>;

export interface ChangeStatusInput {
  shipmentId: string;
  toStatus: ShipmentStatus;
  actor: Actor;
  meta: RequestMeta;
  note?: string | null;
  /** For hub statuses; defaults to the shipment's planned origin/destination hub. */
  hubId?: string | null;
  /** The move is only valid from these statuses (endpoint-specific, e.g. unassign). */
  requireFrom?: readonly ShipmentStatus[];
  /** Extra columns set together with the status (e.g. courierId, cancelledAt). */
  data?: Prisma.ShipmentUncheckedUpdateManyInput;
  /** Extra guard on the update (e.g. courierId: null), and the 409 message if it fails. */
  guard?: Prisma.ShipmentWhereInput;
  guardMessage?: string;
  /** Inside the transaction, before the guarded update (may throw). */
  beforeUpdate?: (tx: Prisma.TransactionClient, shipment: StatusSnapshot) => Promise<void>;
  /** Inside the transaction, after the guarded update. */
  afterUpdate?: (tx: Prisma.TransactionClient, shipment: StatusSnapshot) => Promise<void>;
  /** Audit action; defaults to SHIPMENT_STATUS_CHANGED. */
  auditAction?: AuditAction;
}
