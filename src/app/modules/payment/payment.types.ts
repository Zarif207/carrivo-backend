import type { Prisma } from "../../../generated/prisma/client.js";
import type { PaymentStatus, ShipmentPaymentStatus, ShipmentStatus } from "../../../generated/prisma/enums.js";

/** Columns every caller may see (money formatted by the service). */
export const paymentSelect = {
  id: true,
  amount: true,
  currency: true,
  status: true,
  provider: true,
  paidAmount: true,
  paidCurrency: true,
  paidAt: true,
  refundedAt: true,
  expiresAt: true,
  checkoutUrl: true,
  failureReason: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
  shipment: { select: { id: true, trackingId: true, status: true, paymentStatus: true } },
  // Admin-only (stripped for customers):
  stripeSessionId: true,
  stripePaymentIntentId: true,
  stripeRefundId: true,
  requiresReview: true,
  reviewReason: true,
  user: { select: { id: true, name: true, email: true } },
} as const satisfies Prisma.PaymentSelect;

export type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>;

export interface PaymentDto {
  id: string;
  amount: string;
  currency: string;
  status: PaymentStatus;
  provider: string;
  paidAmount: string | null;
  paidAt: Date | null;
  refundedAt: Date | null;
  expiresAt: Date | null;
  /** Only for the owner while the Checkout Session is still open. */
  checkoutUrl: string | null;
  failureReason: string | null;
  createdAt: Date;
  shipment: { id: string; trackingId: string; status: ShipmentStatus; paymentStatus: ShipmentPaymentStatus };
  /** Admin only. */
  admin?: {
    customer: { id: string; name: string; email: string };
    stripeSessionId: string | null;
    stripePaymentIntentId: string | null;
    stripeRefundId: string | null;
    paidCurrency: string | null;
    requiresReview: boolean;
    reviewReason: string | null;
  };
}

export interface InitiateResult {
  paymentId: string;
  checkoutUrl: string;
  expiresAt: Date;
  amount: string;
  currency: string;
  /** true when an open session was returned instead of creating a new one. */
  reused: boolean;
}

export interface VerifyResult {
  payment: PaymentDto;
  stripe: { sessionStatus: string | null; paymentStatus: string };
}

export type WebhookOutcome =
  | "paid"
  | "already_processed"
  | "duplicate_event"
  | "not_paid"
  | "review_required"
  | "expired"
  | "failed"
  | "error_recorded"
  | "refunded"
  | "refund_failed_recorded"
  | "unknown_payment"
  | "ignored";
