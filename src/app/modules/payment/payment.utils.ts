import { Prisma } from "../../../generated/prisma/client.js";
import { PLATFORM_CURRENCY } from "../../config/currency.js";
import { fromMinorUnits, toMinorUnits } from "../../utils/money.js";

/** Webhook event types we act on. Anything else is acknowledged with 200 and ignored. */
export const HANDLED_STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "payment_intent.payment_failed",
  "charge.refunded",
  "refund.failed",
] as const;

export type HandledStripeEvent = (typeof HANDLED_STRIPE_EVENTS)[number];

export const isHandledStripeEvent = (type: string): type is HandledStripeEvent =>
  (HANDLED_STRIPE_EVENTS as readonly string[]).includes(type);

export interface PaidAmountInput {
  /** What we asked Stripe to charge (Payment.amount). */
  expectedAmount: Prisma.Decimal;
  /** The shipment's current price; must still equal the payment amount. */
  shipmentPrice: Prisma.Decimal;
  /** From the retrieved Checkout Session. */
  sessionAmountTotal: number | null;
  sessionCurrency: string | null;
}

export type PaidAmountCheck =
  | { ok: true; paidAmount: Prisma.Decimal }
  | { ok: false; reason: string; paidAmount: Prisma.Decimal | null };

/**
 * Pure: may this paid Checkout Session mark the shipment paid? Amount (in cents),
 * currency and the shipment's current price must all match exactly.
 */
export const checkPaidAmount = (input: PaidAmountInput): PaidAmountCheck => {
  const paidAmount =
    input.sessionAmountTotal === null || !Number.isSafeInteger(input.sessionAmountTotal)
      ? null
      : fromMinorUnits(input.sessionAmountTotal);
  if (paidAmount === null) return { ok: false, reason: "Stripe reported no amount_total", paidAmount };
  if (input.sessionCurrency !== PLATFORM_CURRENCY) {
    return { ok: false, reason: `Currency mismatch: paid ${input.sessionCurrency ?? "none"}, expected ${PLATFORM_CURRENCY}`, paidAmount };
  }
  if (input.sessionAmountTotal !== toMinorUnits(input.expectedAmount)) {
    return { ok: false, reason: `Amount mismatch: paid ${paidAmount.toFixed(2)}, expected ${input.expectedAmount.toFixed(2)}`, paidAmount };
  }
  if (!input.shipmentPrice.equals(input.expectedAmount)) {
    return {
      ok: false,
      reason: `Shipment price changed to ${input.shipmentPrice.toFixed(2)} after checkout started at ${input.expectedAmount.toFixed(2)}`,
      paidAmount,
    };
  }
  return { ok: true, paidAmount };
};

/** Stripe objects reference related ids either as a string or as an expanded object. */
export const stripeId = (value: string | { id: string } | null | undefined): string | null =>
  value === null || value === undefined ? null : typeof value === "string" ? value : value.id;
