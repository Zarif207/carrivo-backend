import { FRONTEND_PATHS, joinFrontendUrl } from "../../config/frontendRoutes.js";

/**
 * Pure notification/email building: no env, no database, so it is unit-tested
 * directly. The service feeds it facts read inside the business transaction.
 */

export type NotificationKind =
  | "SHIPMENT_CREATED"
  | "COURIER_ASSIGNED"
  | "PICKED_UP"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "FAILED_DELIVERY"
  | "PAYMENT_RECEIVED"
  | "REFUND_COMPLETED";

export type Audience = "CUSTOMER" | "COURIER";

export interface ShipmentFacts {
  id: string;
  trackingId: string;
  receiverName: string;
  deliveryAddress: string;
  serviceType: string;
  /** 2-decimal string, e.g. "6.00". */
  price: string;
  currency: string;
}

export interface PickupFacts {
  address: string;
  contactName: string;
  windowStart: Date;
  windowEnd: Date | null;
}

export type NotificationInput =
  | { type: "SHIPMENT_CREATED"; shipment: ShipmentFacts }
  | { type: "COURIER_ASSIGNED"; audience: Audience; shipment: ShipmentFacts; courierName: string; pickup: PickupFacts | null }
  | { type: "PICKED_UP"; shipment: ShipmentFacts; at: Date }
  | { type: "OUT_FOR_DELIVERY"; shipment: ShipmentFacts }
  | { type: "DELIVERED"; shipment: ShipmentFacts; at: Date }
  | { type: "FAILED_DELIVERY"; shipment: ShipmentFacts; reason: string; attempt: number; maxAttempts: number }
  | { type: "PAYMENT_RECEIVED"; shipment: ShipmentFacts; amount: string; currency: string; at: Date }
  | { type: "REFUND_COMPLETED"; shipment: ShipmentFacts; amount: string; currency: string };

/** What is stored on the Notification row (and is the core of the email). */
export interface NotificationContent {
  type: NotificationKind;
  title: string;
  message: string;
  /** Extra "Label: value" lines for the email only. */
  details: string[];
  /** Frontend path from FRONTEND_PATHS. */
  linkPath: string;
}

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

export const BRAND = "Carrivo";

/** "$6.00 USD" for usd, otherwise "6.00 XYZ". */
export const formatAmount = (amount: string, currency: string): string =>
  currency.toLowerCase() === "usd" ? `$${amount} USD` : `${amount} ${currency.toUpperCase()}`;

/** Deterministic and timezone-free: "2026-11-06 09:15 UTC". */
export const formatDateTime = (date: Date): string => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;

const pickupWindow = (pickup: PickupFacts): string =>
  pickup.windowEnd ? `${formatDateTime(pickup.windowStart)} to ${formatDateTime(pickup.windowEnd)}` : formatDateTime(pickup.windowStart);

const label = (serviceType: string): string => serviceType.replace(/_/g, " ").toLowerCase();

export const buildNotification = (input: NotificationInput): NotificationContent => {
  const s = input.shipment;
  const customerLink = FRONTEND_PATHS.customerShipment(s.id);
  const tracking = `Tracking ID: ${s.trackingId}`;

  switch (input.type) {
    case "SHIPMENT_CREATED":
      return {
        type: input.type,
        title: `Shipment ${s.trackingId} created`,
        message: `Your ${label(s.serviceType)} shipment ${s.trackingId} to ${s.receiverName} was created. Pay ${formatAmount(s.price, s.currency)} to schedule the pickup.`,
        details: [tracking, `Receiver: ${s.receiverName}`, `Price: ${formatAmount(s.price, s.currency)}`],
        linkPath: customerLink,
      };
    case "COURIER_ASSIGNED":
      if (input.audience === "COURIER") {
        return {
          type: input.type,
          title: `New task ${s.trackingId}`,
          message: `You have been assigned shipment ${s.trackingId}.${input.pickup ? ` Pickup from ${input.pickup.address}.` : ""}`,
          details: [
            tracking,
            ...(input.pickup
              ? [`Pickup address: ${input.pickup.address}`, `Contact: ${input.pickup.contactName}`, `Pickup window: ${pickupWindow(input.pickup)}`]
              : []),
          ],
          linkPath: FRONTEND_PATHS.courierTask(s.id),
        };
      }
      return {
        type: input.type,
        title: `Courier assigned to ${s.trackingId}`,
        message: `${firstName(input.courierName)} will pick up your shipment ${s.trackingId}.`,
        details: [tracking, `Courier: ${firstName(input.courierName)}`, ...(input.pickup ? [`Pickup window: ${pickupWindow(input.pickup)}`] : [])],
        linkPath: customerLink,
      };
    case "PICKED_UP":
      return {
        type: input.type,
        title: `${s.trackingId} picked up`,
        message: `Your shipment ${s.trackingId} was picked up and is on its way.`,
        details: [tracking, `Picked up: ${formatDateTime(input.at)}`],
        linkPath: customerLink,
      };
    case "OUT_FOR_DELIVERY":
      return {
        type: input.type,
        title: `${s.trackingId} is out for delivery`,
        message: `Your shipment ${s.trackingId} is out for delivery to ${s.receiverName}.`,
        details: [tracking, `Receiver: ${s.receiverName}`, `Delivery address: ${s.deliveryAddress}`],
        linkPath: customerLink,
      };
    case "DELIVERED":
      return {
        type: input.type,
        title: `${s.trackingId} delivered`,
        message: `Your shipment ${s.trackingId} was delivered to ${s.receiverName}. Proof of delivery is on your shipment page.`,
        details: [tracking, `Delivered: ${formatDateTime(input.at)}`],
        linkPath: customerLink,
      };
    case "FAILED_DELIVERY": {
      const final = input.attempt >= input.maxAttempts;
      return {
        type: input.type,
        title: `Delivery attempt failed for ${s.trackingId}`,
        message: `Delivery attempt ${input.attempt} of ${input.maxAttempts} for ${s.trackingId} failed: ${input.reason}. ${
          final ? "This was the final attempt, so the parcel will be returned." : "We will try again."
        }`,
        details: [tracking, `Reason: ${input.reason}`, `Attempt: ${input.attempt} of ${input.maxAttempts}`],
        linkPath: customerLink,
      };
    }
    case "PAYMENT_RECEIVED":
      return {
        type: input.type,
        title: `Payment received for ${s.trackingId}`,
        message: `We received your payment of ${formatAmount(input.amount, input.currency)} for ${s.trackingId}. You can now schedule the pickup.`,
        details: [tracking, `Amount: ${formatAmount(input.amount, input.currency)}`, `Paid: ${formatDateTime(input.at)}`],
        linkPath: customerLink,
      };
    case "REFUND_COMPLETED":
      return {
        type: input.type,
        title: `Refund completed for ${s.trackingId}`,
        message: `Your refund of ${formatAmount(input.amount, input.currency)} for ${s.trackingId} is complete. It may take 5-10 business days to appear on your statement.`,
        details: [tracking, `Amount: ${formatAmount(input.amount, input.currency)}`],
        linkPath: customerLink,
      };
  }
};

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);

/** Plain, branded email. Every user-supplied value is HTML-escaped. */
export const renderEmail = (
  content: Pick<NotificationContent, "title" | "message" | "details" | "linkPath">,
  options: { recipientName: string; frontendOrigin: string },
): EmailMessage => {
  const link = joinFrontendUrl(options.frontendOrigin, content.linkPath);
  const greeting = `Hi ${firstName(options.recipientName)},`;
  const footer = `This is an automated message from ${BRAND}. Please do not reply.`;

  const text = [greeting, "", content.message, "", ...content.details, "", `View it here: ${link}`, "", "--", footer].join("\n");

  const e = escapeHtml;
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif;color:#1c1917">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px">
<tr><td>
<p style="margin:0 0 16px;font-size:20px;font-weight:bold;color:#0f766e">${BRAND}</p>
<p style="margin:0 0 12px">${e(greeting)}</p>
<p style="margin:0 0 16px;line-height:1.5">${e(content.message)}</p>
${content.details.map((line) => `<p style="margin:0 0 4px;font-size:14px;color:#44403c">${e(line)}</p>`).join("\n")}
<p style="margin:20px 0"><a href="${e(link)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px">View shipment</a></p>
<p style="margin:0 0 16px;font-size:12px;color:#78716c">Or open: ${e(link)}</p>
<p style="margin:0;font-size:12px;color:#78716c">${e(footer)}</p>
</td></tr></table>
</body></html>`;

  return { subject: `${BRAND}: ${content.title}`, text, html };
};
