import { FRONTEND_PATHS } from "../../config/frontendRoutes.js";
import { formatAmount } from "./notification.utils.js";

/**
 * Pure builders for STAFF notifications (ADMIN + ADMIN_VIEWER feed): no env, no database,
 * so the wording, links and dedupe keys are unit-tested directly.
 *
 * Dedupe keys name the EVENT, not the delivery attempt: the same event built twice (a Stripe
 * webhook replay, /payments/verify racing the webhook) gives the same key, and notifyStaff
 * stores "<key>:<userId>" under a unique index, so each admin gets the row at most once.
 * Admin-initiated changes (zones, hubs, users) can't be replayed and have no key.
 */

export type StaffNotificationType =
  | "SHIPMENT_CREATED"
  | "DELIVERED"
  | "FAILED_DELIVERY"
  | "SHIPMENT_CANCELLED"
  | "PAYMENT_RECEIVED"
  | "PAYMENT_FAILED"
  | "REFUND_COMPLETED"
  | "REFUND_FAILED"
  | "ZONE_CHANGED"
  | "HUB_CHANGED"
  | "COURIER_ADDED";

/** What notifyStaff stores for every recipient. */
export interface StaffNotificationInput {
  type: StaffNotificationType;
  title: string;
  message: string;
  /** Frontend path (FRONTEND_PATHS). Falls back to /admin/notifications when absent. */
  link?: string;
  shipmentId?: string;
  /** Event identity; null/absent = no dedupe (one-off admin actions). */
  dedupeKey?: string | null;
}

export interface StaffShipmentFacts {
  id: string;
  trackingId: string;
  /** e.g. "New York Metro" → "Los Angeles Metro" */
  route: string;
  customerName: string;
}

export interface StaffPaymentFacts {
  paymentId: string;
  shipment: Pick<StaffShipmentFacts, "id" | "trackingId">;
  /** 2-decimal string, e.g. "12.50". */
  amount: string;
  currency: string;
}

export type ChangeAction = "created" | "updated" | "deleted";

export type StaffEvent =
  | { kind: "SHIPMENT_CREATED"; shipment: StaffShipmentFacts; serviceType: string; amount: string; currency: string }
  | { kind: "DELIVERED"; shipment: StaffShipmentFacts; courierName: string | null }
  | { kind: "FAILED_DELIVERY"; shipment: StaffShipmentFacts; reason: string; attempt: number; maxAttempts: number }
  | { kind: "SHIPMENT_CANCELLED"; shipment: StaffShipmentFacts; reason: string | null; refundPending: boolean }
  | { kind: "PAYMENT_RECEIVED"; payment: StaffPaymentFacts }
  | { kind: "PAYMENT_FAILED"; payment: StaffPaymentFacts; reason: string }
  | { kind: "REFUND_COMPLETED"; payment: StaffPaymentFacts }
  /** attemptKey: Stripe refund id (webhook) so replays dedupe; null for an API retry that threw. */
  | { kind: "REFUND_FAILED"; payment: StaffPaymentFacts; reason: string; attemptKey: string | null }
  | { kind: "ZONE_CHANGED"; action: ChangeAction; zone: { id: string; code: string; name: string }; actorName: string }
  | { kind: "HUB_CHANGED"; action: ChangeAction; hub: { id: string; code: string; name: string; city: string }; actorName: string }
  | { kind: "COURIER_ADDED"; user: { id: string; name: string; email: string }; zoneName: string | null; via: "created" | "role_changed"; actorName: string };

const label = (value: string): string => value.replace(/_/g, " ").toLowerCase();

/** "an express", "a standard", "a same day". */
const withArticle = (words: string): string => `${/^[aeiou]/.test(words) ? "an" : "a"} ${words}`;

export const buildStaffNotification = (event: StaffEvent): StaffNotificationInput => {
  switch (event.kind) {
    case "SHIPMENT_CREATED": {
      const s = event.shipment;
      return {
        type: "SHIPMENT_CREATED",
        title: `New shipment ${s.trackingId}`,
        message: `${s.customerName} booked ${withArticle(label(event.serviceType))} shipment ${s.trackingId} (${s.route}) for ${formatAmount(event.amount, event.currency)}. Awaiting payment.`,
        link: FRONTEND_PATHS.adminShipment(s.id),
        shipmentId: s.id,
        dedupeKey: `SHIPMENT_CREATED:shipment:${s.id}`,
      };
    }
    case "DELIVERED": {
      const s = event.shipment;
      return {
        type: "DELIVERED",
        title: `${s.trackingId} delivered`,
        message: `Shipment ${s.trackingId} (${s.route}) was delivered${event.courierName ? ` by ${event.courierName}` : ""}.`,
        link: FRONTEND_PATHS.adminShipment(s.id),
        shipmentId: s.id,
        dedupeKey: `DELIVERED:shipment:${s.id}`,
      };
    }
    case "FAILED_DELIVERY": {
      const s = event.shipment;
      const final = event.attempt >= event.maxAttempts;
      return {
        type: "FAILED_DELIVERY",
        title: `Delivery failed for ${s.trackingId}`,
        message: `Attempt ${event.attempt} of ${event.maxAttempts} for ${s.trackingId} failed: ${event.reason}. ${
          final ? "No attempts left: mark it returned." : "It needs another delivery attempt."
        }`,
        link: FRONTEND_PATHS.adminShipment(s.id),
        shipmentId: s.id,
        // One per attempt: attempt 2 is a new event, a replay of attempt 2 is not.
        dedupeKey: `FAILED_DELIVERY:shipment:${s.id}:attempt:${event.attempt}`,
      };
    }
    case "SHIPMENT_CANCELLED": {
      const s = event.shipment;
      return {
        type: "SHIPMENT_CANCELLED",
        title: `${s.trackingId} cancelled`,
        message: `Shipment ${s.trackingId} for ${s.customerName} was cancelled${event.reason ? `: ${event.reason}` : ""}.${
          event.refundPending ? " A refund is being processed." : ""
        }`,
        link: FRONTEND_PATHS.adminShipment(s.id),
        shipmentId: s.id,
        dedupeKey: `SHIPMENT_CANCELLED:shipment:${s.id}`,
      };
    }
    case "PAYMENT_RECEIVED": {
      const p = event.payment;
      return {
        type: "PAYMENT_RECEIVED",
        title: `Payment received for ${p.shipment.trackingId}`,
        message: `${formatAmount(p.amount, p.currency)} was paid for ${p.shipment.trackingId}. It is ready for pickup scheduling.`,
        link: FRONTEND_PATHS.adminShipment(p.shipment.id),
        shipmentId: p.shipment.id,
        // From the payment, not the Stripe event: webhook replays AND /verify share it.
        dedupeKey: `PAYMENT_RECEIVED:payment:${p.paymentId}`,
      };
    }
    case "PAYMENT_FAILED": {
      const p = event.payment;
      return {
        type: "PAYMENT_FAILED",
        title: `Payment failed for ${p.shipment.trackingId}`,
        message: `The ${formatAmount(p.amount, p.currency)} payment for ${p.shipment.trackingId} failed: ${event.reason}. The customer must start a new payment.`,
        link: FRONTEND_PATHS.adminPayments({ status: "FAILED" }),
        shipmentId: p.shipment.id,
        dedupeKey: `PAYMENT_FAILED:payment:${p.paymentId}`,
      };
    }
    case "REFUND_COMPLETED": {
      const p = event.payment;
      return {
        type: "REFUND_COMPLETED",
        title: `Refund completed for ${p.shipment.trackingId}`,
        message: `${formatAmount(p.amount, p.currency)} was refunded for ${p.shipment.trackingId}.`,
        link: FRONTEND_PATHS.adminPayments({ status: "REFUNDED" }),
        shipmentId: p.shipment.id,
        dedupeKey: `REFUND_COMPLETED:payment:${p.paymentId}`,
      };
    }
    case "REFUND_FAILED": {
      const p = event.payment;
      return {
        type: "REFUND_FAILED",
        title: `Refund failed for ${p.shipment.trackingId}`,
        message: `The ${formatAmount(p.amount, p.currency)} refund for ${p.shipment.trackingId} failed: ${event.reason}. Retry it from Payments.`,
        link: FRONTEND_PATHS.adminPayments({ requiresReview: true }),
        shipmentId: p.shipment.id,
        dedupeKey: event.attemptKey ? `REFUND_FAILED:payment:${p.paymentId}:${event.attemptKey}` : null,
      };
    }
    case "ZONE_CHANGED":
      return {
        type: "ZONE_CHANGED",
        title: `Zone ${event.zone.code} ${event.action}`,
        message: `${event.actorName} ${event.action} the zone ${event.zone.name} (${event.zone.code}).`,
        link: FRONTEND_PATHS.adminSettings("zones"),
        dedupeKey: null,
      };
    case "HUB_CHANGED":
      return {
        type: "HUB_CHANGED",
        title: `Hub ${event.hub.code} ${event.action}`,
        message: `${event.actorName} ${event.action} the hub ${event.hub.name} (${event.hub.code}, ${event.hub.city}).`,
        link: FRONTEND_PATHS.adminSettings("hubs"),
        dedupeKey: null,
      };
    case "COURIER_ADDED":
      return {
        type: "COURIER_ADDED",
        title: `New courier: ${event.user.name}`,
        message: `${event.actorName} ${event.via === "created" ? "created a courier account for" : "made"} ${event.user.name} (${event.user.email})${
          event.via === "role_changed" ? " a courier" : ""
        }${event.zoneName ? ` in ${event.zoneName}` : ""}.`,
        link: FRONTEND_PATHS.adminUsers,
        dedupeKey: null,
      };
  }
};
