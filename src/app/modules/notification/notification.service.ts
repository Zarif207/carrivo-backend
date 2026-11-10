import { waitUntil } from "@vercel/functions";
import httpStatus from "http-status";
import type { Prisma } from "../../../generated/prisma/client.js";
import { EmailStatus, ShipmentStatus } from "../../../generated/prisma/enums.js";
import { env } from "../../config/env.js";
import { emailSender } from "../../lib/email.js";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../utils/ApiError.js";
import { formatMoney } from "../../utils/money.js";
import { buildMeta, getSkipTake, type Paginated } from "../../utils/pagination.js";
import { MAX_DELIVERY_ATTEMPTS } from "../shipment/shipment.constants.js";
import {
  notificationPickupSelect,
  notificationSelect,
  notificationShipmentSelect,
  recipientSelect,
  type NotificationDto,
  type NotificationRow,
  type NotificationShipmentRow,
  type PendingEmail,
  type Recipient,
} from "./notification.types.js";
import { buildNotification, renderEmail, type NotificationInput, type ShipmentFacts } from "./notification.utils.js";
import type { MyNotificationsQuery } from "./notification.validation.js";

type Db = Prisma.TransactionClient;

const facts = (row: NotificationShipmentRow): ShipmentFacts => ({
  id: row.id,
  trackingId: row.trackingId,
  receiverName: row.receiverName,
  deliveryAddress: row.deliveryAddress,
  serviceType: row.serviceType,
  price: formatMoney(row.price),
  currency: row.currency,
});

/** Sequential queries on the transaction client (see notificationShipmentSelect). */
const loadShipment = async (db: Db, shipmentId: string): Promise<NotificationShipmentRow> => {
  const row = await db.shipment.findUniqueOrThrow({ where: { id: shipmentId }, select: notificationShipmentSelect });
  const customer = await db.user.findUniqueOrThrow({ where: { id: row.customerId }, select: recipientSelect });
  const courier = row.courierId ? await db.user.findUnique({ where: { id: row.courierId }, select: recipientSelect }) : null;
  const pickupRequest = await db.pickupRequest.findUnique({ where: { shipmentId }, select: notificationPickupSelect });
  return { ...row, customer, courier, pickupRequest };
};

/** Inserts the rows with the CALLER'S transaction client, and returns the emails to send after commit. */
const insert = async (db: Db, shipmentId: string, items: { recipient: Recipient; input: NotificationInput }[]): Promise<PendingEmail[]> => {
  const pending: PendingEmail[] = [];
  for (const { recipient, input } of items) {
    const content = buildNotification(input);
    const row = await db.notification.create({
      data: { userId: recipient.id, shipmentId, type: content.type, title: content.title, message: content.message, link: content.linkPath },
      select: { id: true },
    });
    pending.push({ notificationId: row.id, to: recipient.email, recipientName: recipient.name, content });
  }
  return pending;
};

/** Status → notifications. The ONE place deciding who hears about which status change. */
const forStatusChange = async (db: Db, shipmentId: string, toStatus: ShipmentStatus): Promise<PendingEmail[]> => {
  const watched: ShipmentStatus[] = [
    ShipmentStatus.COURIER_ASSIGNED,
    ShipmentStatus.PICKED_UP,
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.FAILED_DELIVERY,
  ];
  if (!watched.includes(toStatus)) return [];

  const row = await loadShipment(db, shipmentId);
  const shipment = facts(row);
  const customer = row.customer;
  const now = new Date();

  switch (toStatus) {
    case ShipmentStatus.COURIER_ASSIGNED: {
      if (!row.courier) return [];
      const pickup = row.pickupRequest
        ? {
            address: row.pickupRequest.pickupAddress,
            contactName: row.pickupRequest.contactName,
            windowStart: row.pickupRequest.scheduledAt,
            windowEnd: row.pickupRequest.scheduledUntil,
          }
        : null;
      const base = { type: "COURIER_ASSIGNED", shipment, courierName: row.courier.name, pickup } as const;
      return insert(db, shipmentId, [
        { recipient: customer, input: { ...base, audience: "CUSTOMER" } },
        { recipient: row.courier, input: { ...base, audience: "COURIER" } },
      ]);
    }
    case ShipmentStatus.PICKED_UP:
      return insert(db, shipmentId, [{ recipient: customer, input: { type: "PICKED_UP", shipment, at: row.pickedUpAt ?? now } }]);
    case ShipmentStatus.OUT_FOR_DELIVERY:
      return insert(db, shipmentId, [{ recipient: customer, input: { type: "OUT_FOR_DELIVERY", shipment } }]);
    case ShipmentStatus.DELIVERED:
      return insert(db, shipmentId, [{ recipient: customer, input: { type: "DELIVERED", shipment, at: row.deliveredAt ?? now } }]);
    case ShipmentStatus.FAILED_DELIVERY:
      return insert(db, shipmentId, [
        {
          recipient: customer,
          input: {
            type: "FAILED_DELIVERY",
            shipment,
            reason: row.failureReason ?? "Delivery failed",
            attempt: row.failedAttempts,
            maxAttempts: MAX_DELIVERY_ATTEMPTS,
          },
        },
      ]);
    default:
      return [];
  }
};

const forShipmentCreated = async (db: Db, shipmentId: string): Promise<PendingEmail[]> => {
  const row = await loadShipment(db, shipmentId);
  return insert(db, shipmentId, [{ recipient: row.customer, input: { type: "SHIPMENT_CREATED", shipment: facts(row) } }]);
};

const forPaymentReceived = async (db: Db, shipmentId: string, amount: Prisma.Decimal, at: Date): Promise<PendingEmail[]> => {
  const row = await loadShipment(db, shipmentId);
  return insert(db, shipmentId, [
    {
      recipient: row.customer,
      input: { type: "PAYMENT_RECEIVED", shipment: facts(row), amount: formatMoney(amount), currency: row.currency, at },
    },
  ]);
};

const forRefundCompleted = async (db: Db, shipmentId: string, amount: Prisma.Decimal): Promise<PendingEmail[]> => {
  const row = await loadShipment(db, shipmentId);
  return insert(db, shipmentId, [
    { recipient: row.customer, input: { type: "REFUND_COMPLETED", shipment: facts(row), amount: formatMoney(amount), currency: row.currency } },
  ]);
};

/** Sends one email and records the outcome. Never throws. */
const deliverOne = async (email: PendingEmail): Promise<void> => {
  const message = renderEmail(email.content, { recipientName: email.recipientName, frontendOrigin: env.FRONTEND_URL });
  const result = await emailSender.send({ to: email.to, ...message, idempotencyKey: `notification/${email.notificationId}` });
  try {
    await prisma.notification.updateMany({
      where: { id: email.notificationId, emailStatus: EmailStatus.PENDING },
      data:
        result.status === "SENT"
          ? { emailStatus: EmailStatus.SENT, emailSentAt: new Date(), emailError: null }
          : result.status === "SKIPPED"
            ? { emailStatus: EmailStatus.SKIPPED, emailError: result.reason }
            : { emailStatus: EmailStatus.FAILED, emailError: result.error },
    });
  } catch (error) {
    console.warn(`[notification] could not record email status for ${email.notificationId}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (result.status === "FAILED") console.warn(`[notification] email for ${email.notificationId} failed: ${result.error}`);
};

/**
 * Call AFTER the business transaction commits. Returns immediately: the emails
 * are sent in the background. On Vercel, waitUntil keeps the function alive until
 * they finish (a plain floating promise could be frozen with the response).
 * Locally waitUntil is a no-op and the promise simply runs. Resolves when done
 * (tests may await it; request handlers never do).
 */
const sendAfterCommit = (emails: PendingEmail[]): Promise<void> => {
  if (emails.length === 0) return Promise.resolve();
  const work = Promise.allSettled(emails.map(deliverOne)).then(() => undefined);
  try {
    waitUntil(work);
  } catch {
    // Outside a Vercel request context, the promise just runs on its own.
  }
  return work;
};

// ───────── API ─────────

const toDto = (row: NotificationRow): NotificationDto => ({ ...row, isRead: row.readAt !== null });

const listMine = async (userId: string, query: MyNotificationsQuery): Promise<Paginated<NotificationDto>> => {
  const where: Prisma.NotificationWhereInput = {
    userId,
    ...(query.unread === undefined ? {} : query.unread ? { readAt: null } : { readAt: { not: null } }),
  };
  const [rows, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      select: notificationSelect,
      orderBy: [{ createdAt: query.sortOrder }, { id: query.sortOrder }],
      ...getSkipTake(query),
    }),
    prisma.notification.count({ where }),
  ]);
  return { data: rows.map(toDto), meta: buildMeta(query, total) };
};

/** Own notifications only (others → 404). Marking an already-read one keeps its readAt. */
const markRead = async (userId: string, id: string): Promise<NotificationDto> => {
  await prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
  const row = await prisma.notification.findFirst({ where: { id, userId }, select: notificationSelect });
  if (!row) throw new ApiError(httpStatus.NOT_FOUND, "Notification not found");
  return toDto(row);
};

const markAllRead = async (userId: string): Promise<{ updated: number }> => {
  const { count } = await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  return { updated: count };
};

/** The caller's unread total (for a badge), plus their total. */
const unreadCount = async (userId: string): Promise<{ unread: number; total: number }> => {
  const [unread, total] = await Promise.all([
    prisma.notification.count({ where: { userId, readAt: null } }),
    prisma.notification.count({ where: { userId } }),
  ]);
  return { unread, total };
};

/**
 * Deletes one of the caller's own notifications (others → 404, never revealed).
 * A notification is a personal inbox item, not a business record, so this is a real
 * delete; shipments, payments and the audit log are untouched.
 */
const remove = async (userId: string, id: string): Promise<{ id: string }> => {
  const { count } = await prisma.notification.deleteMany({ where: { id, userId } });
  if (count === 0) throw new ApiError(httpStatus.NOT_FOUND, "Notification not found");
  return { id };
};

export const NotificationService = {
  forStatusChange,
  forShipmentCreated,
  forPaymentReceived,
  forRefundCompleted,
  sendAfterCommit,
  listMine,
  markRead,
  markAllRead,
  unreadCount,
  remove,
};
