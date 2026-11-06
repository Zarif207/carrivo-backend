import type { Prisma } from "../../../generated/prisma/client.js";
import type { NotificationContent } from "./notification.utils.js";

/**
 * What the business transaction reads to build notifications. Scalars only: the
 * related rows are read in separate sequential queries, because inside a
 * transaction Prisma would run relation queries concurrently on its one connection
 * (deprecated by pg, removed in pg@9).
 */
export const notificationShipmentSelect = {
  id: true,
  trackingId: true,
  receiverName: true,
  deliveryAddress: true,
  serviceType: true,
  price: true,
  currency: true,
  failedAttempts: true,
  failureReason: true,
  pickedUpAt: true,
  deliveredAt: true,
  customerId: true,
  courierId: true,
} as const satisfies Prisma.ShipmentSelect;

export const recipientSelect = { id: true, name: true, email: true } as const satisfies Prisma.UserSelect;
export type Recipient = Prisma.UserGetPayload<{ select: typeof recipientSelect }>;

export const notificationPickupSelect = {
  pickupAddress: true,
  contactName: true,
  scheduledAt: true,
  scheduledUntil: true,
} as const satisfies Prisma.PickupRequestSelect;

export type NotificationShipmentRow = Prisma.ShipmentGetPayload<{ select: typeof notificationShipmentSelect }> & {
  customer: Recipient;
  courier: Recipient | null;
  pickupRequest: Prisma.PickupRequestGetPayload<{ select: typeof notificationPickupSelect }> | null;
};

/**
 * An email to send after the transaction commits. Built from the same facts as
 * the row, so nothing has to be re-read (and nothing is sent if it rolls back).
 */
export interface PendingEmail {
  notificationId: string;
  to: string;
  recipientName: string;
  content: NotificationContent;
}

export const notificationSelect = {
  id: true,
  type: true,
  title: true,
  message: true,
  readAt: true,
  createdAt: true,
  shipment: { select: { id: true, trackingId: true } },
} as const satisfies Prisma.NotificationSelect;

export type NotificationRow = Prisma.NotificationGetPayload<{ select: typeof notificationSelect }>;

export type NotificationDto = NotificationRow & { isRead: boolean };
