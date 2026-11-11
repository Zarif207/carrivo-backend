import type { Prisma } from "../../../generated/prisma/client.js";
import { EmailStatus, PaymentStatus, ShipmentStatus, UserStatus } from "../../../generated/prisma/enums.js";
import { FRONTEND_PATHS } from "../../config/frontendRoutes.js";
import { STAFF_ROLES } from "../../config/roles.js";
import { prisma } from "../../lib/prisma.js";
import { formatMoney } from "../../utils/money.js";
import type { Actor } from "../audit/audit.types.js";
import { MAX_DELIVERY_ATTEMPTS } from "../shipment/shipment.constants.js";
import {
  buildStaffNotification,
  type ChangeAction,
  type StaffEvent,
  type StaffNotificationInput,
  type StaffPaymentFacts,
  type StaffShipmentFacts,
} from "./notification.staff.utils.js";

/**
 * Staff notifications: one in-app row per active ADMIN / ADMIN_VIEWER for events an operator
 * needs to see. Always called AFTER the business transaction commits, and never throws: a
 * notification problem is logged and the main request carries on.
 */

/** Who receives staff notifications: active, not deleted, ADMIN or ADMIN_VIEWER. Never customers or couriers. */
export const STAFF_RECIPIENT_WHERE = {
  role: { in: [...STAFF_ROLES] },
  status: UserStatus.ACTIVE,
  deletedAt: null,
} as const satisfies Prisma.UserWhereInput;

/** Staff rows are in-app only; the email columns record that no email is sent. */
export const STAFF_EMAIL_NOTE = "Staff notifications are in-app only";

/** The two queries notifyStaff needs (the Prisma client, or an in-memory fake in tests). */
export interface StaffNotifyDb {
  user: { findMany(args: { where: Prisma.UserWhereInput; select: { id: true } }): Promise<{ id: string }[]> };
  notification: { createMany(args: { data: Prisma.NotificationCreateManyInput[]; skipDuplicates: boolean }): Promise<{ count: number }> };
}

export interface NotifyStaffResult {
  recipients: number;
  /** Rows actually inserted (0 for a replayed event). */
  created: number;
}

const warn = (what: string, error: unknown): void =>
  console.warn(`[notification] staff ${what} skipped: ${error instanceof Error ? error.message : "unknown error"}`);

/** Builds the rows for a recipient list (pure, exported for tests). */
export const staffRows = (input: StaffNotificationInput, recipientIds: string[]): Prisma.NotificationCreateManyInput[] =>
  recipientIds.map((userId) => ({
    userId,
    type: input.type,
    title: input.title,
    message: input.message,
    link: input.link ?? FRONTEND_PATHS.adminNotifications,
    shipmentId: input.shipmentId ?? null,
    dedupeKey: input.dedupeKey ? `${input.dedupeKey}:${userId}` : null,
    emailStatus: EmailStatus.SKIPPED,
    emailError: STAFF_EMAIL_NOTE,
  }));

/**
 * One row per active staff user (createMany; duplicates of an already-recorded event are
 * skipped by the unique dedupeKey). Never throws.
 */
export const notifyStaff = async (input: StaffNotificationInput, db: StaffNotifyDb = prisma): Promise<NotifyStaffResult> => {
  try {
    const recipients = await db.user.findMany({ where: STAFF_RECIPIENT_WHERE, select: { id: true } });
    if (recipients.length === 0) return { recipients: 0, created: 0 };
    const { count } = await db.notification.createMany({
      data: staffRows(
        input,
        recipients.map((r) => r.id),
      ),
      skipDuplicates: true,
    });
    return { recipients: recipients.length, created: count };
  } catch (error) {
    warn(input.type, error);
    return { recipients: 0, created: 0 };
  }
};

// ───────── Event loaders (read the facts after commit, then notifyStaff) ─────────

/** Loads facts and notifies; a failure while loading is logged like any other. Never throws. */
const run = async (what: string, load: () => Promise<StaffEvent | null>): Promise<void> => {
  try {
    const event = await load();
    if (event) await notifyStaff(buildStaffNotification(event));
  } catch (error) {
    warn(what, error);
  }
};

const shipmentFactsSelect = {
  id: true,
  trackingId: true,
  serviceType: true,
  price: true,
  currency: true,
  failureReason: true,
  failedAttempts: true,
  cancelReason: true,
  customer: { select: { name: true } },
  courier: { select: { name: true } },
  originZone: { select: { name: true } },
  destinationZone: { select: { name: true } },
} as const satisfies Prisma.ShipmentSelect;

const loadShipment = (id: string) => prisma.shipment.findUniqueOrThrow({ where: { id }, select: shipmentFactsSelect });
type ShipmentRow = Awaited<ReturnType<typeof loadShipment>>;

const shipmentFacts = (s: ShipmentRow): StaffShipmentFacts => ({
  id: s.id,
  trackingId: s.trackingId,
  route: s.originZone.name === s.destinationZone.name ? `within ${s.originZone.name}` : `${s.originZone.name} to ${s.destinationZone.name}`,
  customerName: s.customer.name,
});

const loadPayment = async (paymentId: string): Promise<StaffPaymentFacts> => {
  const p = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: { id: true, amount: true, paidAmount: true, currency: true, shipment: { select: { id: true, trackingId: true } } },
  });
  return { paymentId: p.id, shipment: p.shipment, amount: formatMoney(p.paidAmount ?? p.amount), currency: p.currency };
};

const actorName = async (actor: Actor): Promise<string> =>
  (await prisma.user.findUnique({ where: { id: actor.id }, select: { name: true } }))?.name ?? "An admin";

/** The statuses staff hear about; every other status change stays quiet. */
export const STAFF_WATCHED_STATUSES: readonly ShipmentStatus[] = [ShipmentStatus.DELIVERED, ShipmentStatus.FAILED_DELIVERY, ShipmentStatus.CANCELLED];

export const StaffNotify = {
  shipmentCreated: (shipmentId: string): Promise<void> =>
    run("SHIPMENT_CREATED", async () => {
      const s = await loadShipment(shipmentId);
      return { kind: "SHIPMENT_CREATED", shipment: shipmentFacts(s), serviceType: s.serviceType, amount: formatMoney(s.price), currency: s.currency };
    }),

  /** No-op for statuses outside STAFF_WATCHED_STATUSES. */
  shipmentStatus: (shipmentId: string, toStatus: ShipmentStatus): Promise<void> => {
    if (!STAFF_WATCHED_STATUSES.includes(toStatus)) return Promise.resolve();
    return run(toStatus, async () => {
      const s = await loadShipment(shipmentId);
      const shipment = shipmentFacts(s);
      switch (toStatus) {
        case ShipmentStatus.DELIVERED:
          return { kind: "DELIVERED", shipment, courierName: s.courier?.name ?? null };
        case ShipmentStatus.FAILED_DELIVERY:
          return {
            kind: "FAILED_DELIVERY",
            shipment,
            reason: s.failureReason ?? "Delivery failed",
            attempt: s.failedAttempts,
            maxAttempts: MAX_DELIVERY_ATTEMPTS,
          };
        case ShipmentStatus.CANCELLED: {
          const refundPending = (await prisma.payment.count({ where: { shipmentId, status: PaymentStatus.REFUND_PENDING } })) > 0;
          return { kind: "SHIPMENT_CANCELLED", shipment, reason: s.cancelReason, refundPending };
        }
        default:
          return null;
      }
    });
  },

  paymentReceived: (paymentId: string): Promise<void> =>
    run("PAYMENT_RECEIVED", async () => ({ kind: "PAYMENT_RECEIVED", payment: await loadPayment(paymentId) })),

  paymentFailed: (paymentId: string, reason: string): Promise<void> =>
    run("PAYMENT_FAILED", async () => ({ kind: "PAYMENT_FAILED", payment: await loadPayment(paymentId), reason })),

  refundCompleted: (paymentId: string): Promise<void> =>
    run("REFUND_COMPLETED", async () => ({ kind: "REFUND_COMPLETED", payment: await loadPayment(paymentId) })),

  refundFailed: (paymentId: string, reason: string, attemptKey: string | null): Promise<void> =>
    run("REFUND_FAILED", async () => ({ kind: "REFUND_FAILED", payment: await loadPayment(paymentId), reason, attemptKey })),

  zoneChanged: (action: ChangeAction, zone: { id: string; code: string; name: string }, actor: Actor): Promise<void> =>
    run("ZONE_CHANGED", async () => ({ kind: "ZONE_CHANGED", action, zone, actorName: await actorName(actor) })),

  hubChanged: (action: ChangeAction, hub: { id: string; code: string; name: string; city: string }, actor: Actor): Promise<void> =>
    run("HUB_CHANGED", async () => ({ kind: "HUB_CHANGED", action, hub, actorName: await actorName(actor) })),

  courierAdded: (
    user: { id: string; name: string; email: string; zoneName: string | null },
    via: "created" | "role_changed" | "application",
    actor: Actor,
    applicationId?: string,
  ): Promise<void> =>
    run("COURIER_ADDED", async () => ({
      kind: "COURIER_ADDED",
      user: { id: user.id, name: user.name, email: user.email },
      zoneName: user.zoneName,
      via,
      actorName: await actorName(actor),
      ...(applicationId ? { applicationId } : {}),
    })),

  courierApplicationSubmitted: (application: { id: string; vehicleType: string; zoneName: string | null }, applicant: { name: string; email: string }): Promise<void> =>
    run("COURIER_APPLICATION_SUBMITTED", async () => ({ kind: "COURIER_APPLICATION_SUBMITTED", application, applicant })),
};
