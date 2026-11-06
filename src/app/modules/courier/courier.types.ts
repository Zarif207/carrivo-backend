import type { Prisma } from "../../../generated/prisma/client.js";
import type { WithMoney } from "../../utils/money.js";
import { hubRefSelect } from "../hub/hub.types.js";
import { pickupRequestSelect, shipmentListSelect } from "../shipment/shipment.types.js";
import { zoneRefSelect } from "../zone/zone.types.js";

export const courierProfileSelect = {
  id: true,
  vehicleType: true,
  vehicleNumber: true,
  isAvailable: true,
  zone: { select: zoneRefSelect },
  hub: { select: hubRefSelect },
} as const satisfies Prisma.CourierProfileSelect;

export type CourierProfileDto = Prisma.CourierProfileGetPayload<{ select: typeof courierProfileSelect }>;

/** One courier for the admin assignment screen. `id` is the User id to send to /assign. */
export interface CourierListItem {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  courierProfile: CourierProfileDto | null;
  activeTaskCount: number;
}

/** A courier's task: list fields plus what is needed to do the pickup/delivery. */
export const courierTaskSelect = {
  ...shipmentListSelect,
  senderPhone: true,
  isFragile: true,
  description: true,
  failedAttempts: true,
  failureReason: true,
  // Only the assigned courier ever reads a task, so the proof is safe to include.
  proofOfDeliveryUrl: true,
  proofOfDeliveryUploadedAt: true,
  currentHub: { select: hubRefSelect },
  pickupRequest: { select: pickupRequestSelect },
} as const satisfies Prisma.ShipmentSelect;

export type CourierTaskRow = Prisma.ShipmentGetPayload<{ select: typeof courierTaskSelect }>;
export type CourierTask = WithMoney<CourierTaskRow, "price">;

export const earningSelect = {
  id: true,
  amount: true,
  status: true,
  paidOutAt: true,
  createdAt: true,
  shipment: { select: { id: true, trackingId: true, serviceType: true, price: true } },
} as const satisfies Prisma.CourierEarningSelect;

export type EarningRow = Prisma.CourierEarningGetPayload<{ select: typeof earningSelect }>;
export type EarningItem = Omit<EarningRow, "amount" | "shipment"> & {
  amount: string;
  shipment: Omit<EarningRow["shipment"], "price"> & { price: string };
};

export interface EarningSummary {
  totalEarned: string;
  pending: string;
  paidOut: string;
  deliveries: number;
}

export interface EarningsResult {
  summary: EarningSummary;
  earnings: EarningItem[];
}
