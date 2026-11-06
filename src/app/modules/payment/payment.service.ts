import httpStatus from "http-status";
import Stripe from "stripe";
import { Prisma } from "../../../generated/prisma/client.js";
import { PaymentStatus, Role, ShipmentPaymentStatus, ShipmentStatus } from "../../../generated/prisma/enums.js";
import { PLATFORM_CURRENCY, STRIPE_MIN_CHARGE } from "../../config/currency.js";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { stripe } from "../../lib/stripe.js";
import { ApiError } from "../../utils/ApiError.js";
import { formatMoney, toMinorUnits } from "../../utils/money.js";
import { buildMeta, buildOrderBy, getSkipTake, type Paginated } from "../../utils/pagination.js";
import type { RequestMeta } from "../../utils/requestMeta.js";
import { AUDIT_ACTIONS, AUDIT_ENTITIES, type AuditAction } from "../audit/audit.constants.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor } from "../audit/audit.types.js";
import {
  paymentSelect,
  type InitiateResult,
  type PaymentDto,
  type PaymentRow,
  type VerifyResult,
  type WebhookOutcome,
} from "./payment.types.js";
import { checkPaidAmount, isHandledStripeEvent, stripeId } from "./payment.utils.js";
import type { AdminPaymentsQuery, MyPaymentsQuery } from "./payment.validation.js";

type Db = Prisma.TransactionClient;

/** Stripe's minimum Checkout lifetime is 30 min; one extra minute absorbs clock skew. */
const CHECKOUT_TTL_MS = 31 * 60_000;
/** A PENDING row with no session yet is "being prepared"; after this it's treated as abandoned. */
const PREPARING_GRACE_MS = 2 * 60_000;

const STRIPE_PROVIDER = "STRIPE";
const NOT_FOUND = (): ApiError => new ApiError(httpStatus.NOT_FOUND, "Payment not found");
const conflict = (message: string): ApiError => new ApiError(httpStatus.CONFLICT, message);
const belowMinimum = (): ApiError =>
  new ApiError(httpStatus.UNPROCESSABLE_ENTITY, "Amount is below Stripe's minimum charge", [
    { path: "amount", message: `Stripe requires at least ${STRIPE_MIN_CHARGE} ${PLATFORM_CURRENCY.toUpperCase()}` },
  ]);
const errorText = (error: unknown): string => (error instanceof Error ? error.message : "Unknown error").slice(0, 500);

const audit = (
  db: Db,
  action: AuditAction,
  paymentId: string,
  after: unknown,
  actor: Actor | null = null,
  meta?: RequestMeta,
  before?: unknown,
): Promise<void> =>
  AuditService.log(db, {
    actor,
    action,
    entityType: AUDIT_ENTITIES.PAYMENT,
    entityId: paymentId,
    before,
    after,
    ...(meta ? { meta } : {}),
  });

// ───────── Read model ─────────

const toDto = (row: PaymentRow, viewer: Actor): PaymentDto => {
  const isAdmin = viewer.role === Role.ADMIN;
  const open = row.status === PaymentStatus.PENDING && row.expiresAt !== null && row.expiresAt > new Date();
  return {
    id: row.id,
    amount: formatMoney(row.amount),
    currency: row.currency,
    status: row.status,
    provider: row.provider,
    paidAmount: row.paidAmount ? formatMoney(row.paidAmount) : null,
    paidAt: row.paidAt,
    refundedAt: row.refundedAt,
    expiresAt: row.expiresAt,
    checkoutUrl: row.userId === viewer.id && open ? row.checkoutUrl : null,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    shipment: row.shipment,
    ...(isAdmin
      ? {
          admin: {
            customer: row.user,
            stripeSessionId: row.stripeSessionId,
            stripePaymentIntentId: row.stripePaymentIntentId,
            stripeRefundId: row.stripeRefundId,
            paidCurrency: row.paidCurrency,
            requiresReview: row.requiresReview,
            reviewReason: row.reviewReason,
          },
        }
      : {}),
  };
};

/** Owner or admin; anyone else gets 404 so ids can't be probed. */
const getById = async (viewer: Actor, id: string): Promise<PaymentDto> => {
  const row = await prisma.payment.findFirst({
    where: { id, ...(viewer.role === Role.ADMIN ? {} : { userId: viewer.id }) },
    select: paymentSelect,
  });
  if (!row) throw NOT_FOUND();
  return toDto(row, viewer);
};

const listPayments = async (
  viewer: Actor,
  where: Prisma.PaymentWhereInput,
  query: MyPaymentsQuery | AdminPaymentsQuery,
): Promise<Paginated<PaymentDto>> => {
  const [rows, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      select: paymentSelect,
      orderBy: buildOrderBy(query.sortBy, query.sortOrder),
      ...getSkipTake(query),
    }),
    prisma.payment.count({ where }),
  ]);
  return { data: rows.map((row) => toDto(row, viewer)), meta: buildMeta(query, total) };
};

const listMine = (viewer: Actor, query: MyPaymentsQuery): Promise<Paginated<PaymentDto>> =>
  listPayments(viewer, { userId: viewer.id, ...(query.status ? { status: query.status } : {}) }, query);

const adminList = (viewer: Actor, query: AdminPaymentsQuery): Promise<Paginated<PaymentDto>> =>
  listPayments(
    viewer,
    {
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { userId: query.customerId } : {}),
      ...(query.shipmentId ? { shipmentId: query.shipmentId } : {}),
      ...(query.requiresReview !== undefined ? { requiresReview: query.requiresReview } : {}),
      ...(query.fromDate || query.toDate
        ? { createdAt: { ...(query.fromDate ? { gte: query.fromDate } : {}), ...(query.toDate ? { lte: query.toDate } : {}) } }
        : {}),
    },
    query,
  );

// ───────── Initiate ─────────

const withQuery = (url: string, params: string): string => `${url}${url.includes("?") ? "&" : "?"}${params}`;

/**
 * Customer starts paying for their own unpaid shipment. If an open Checkout
 * Session already exists it is returned instead of creating a second one.
 * The DB step runs under a shipment row lock, so concurrent calls can't create
 * two payments; the Stripe call happens after commit with an idempotency key.
 */
const initiate = async (actor: Actor, shipmentId: string, meta: RequestMeta): Promise<InitiateResult> => {
  const prepared = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "shipments" WHERE "id" = ${shipmentId} FOR UPDATE`;
    const shipment = await tx.shipment.findFirst({
      where: { id: shipmentId, customerId: actor.id, deletedAt: null },
      select: {
        id: true,
        trackingId: true,
        status: true,
        paymentStatus: true,
        price: true,
        currency: true,
        serviceType: true,
        customer: { select: { email: true } },
      },
    });
    if (!shipment) throw new ApiError(httpStatus.NOT_FOUND, "Shipment not found");
    if (shipment.paymentStatus !== ShipmentPaymentStatus.UNPAID) throw conflict(`Shipment is already ${shipment.paymentStatus}`);
    const closed: ShipmentStatus[] = [ShipmentStatus.CANCELLED, ShipmentStatus.RETURNED, ShipmentStatus.DELIVERED];
    if (closed.includes(shipment.status)) throw conflict(`A ${shipment.status} shipment cannot be paid`);
    if (shipment.currency !== PLATFORM_CURRENCY) {
      throw conflict(`Shipment is priced in ${shipment.currency}; only ${PLATFORM_CURRENCY} shipments can be paid`);
    }
    // Checked here so no Payment row or Stripe call is made for an amount Stripe would refuse.
    if (shipment.price.lessThan(STRIPE_MIN_CHARGE)) throw belowMinimum();

    const now = Date.now();
    const pending = await tx.payment.findFirst({
      where: { shipmentId, status: PaymentStatus.PENDING },
      orderBy: { createdAt: "desc" },
      select: { id: true, amount: true, currency: true, checkoutUrl: true, expiresAt: true, stripeSessionId: true, createdAt: true },
    });
    if (pending) {
      if (pending.stripeSessionId && pending.checkoutUrl && pending.expiresAt && pending.expiresAt.getTime() > now) {
        return { kind: "reuse", reuse: pending } as const;
      }
      if (!pending.stripeSessionId && now - pending.createdAt.getTime() < PREPARING_GRACE_MS) {
        throw conflict("A payment for this shipment is being prepared; try again in a moment");
      }
      // Expired session, or abandoned preparation: close it before starting a new one.
      const status = pending.stripeSessionId ? PaymentStatus.EXPIRED : PaymentStatus.FAILED;
      await tx.payment.updateMany({
        where: { id: pending.id, status: PaymentStatus.PENDING },
        data: { status, checkoutUrl: null, ...(status === PaymentStatus.FAILED ? { failureReason: "Checkout preparation abandoned" } : {}) },
      });
    }

    const payment = await tx.payment.create({
      data: {
        shipmentId,
        userId: actor.id,
        amount: shipment.price,
        currency: PLATFORM_CURRENCY,
        status: PaymentStatus.PENDING,
        provider: STRIPE_PROVIDER,
      },
      select: { id: true, amount: true },
    });
    await audit(tx, AUDIT_ACTIONS.PAYMENT_INITIATED, payment.id, { shipmentId, amount: payment.amount, currency: PLATFORM_CURRENCY }, actor, meta);
    return { kind: "create", create: payment, shipment } as const;
  });

  if (prepared.kind === "reuse") {
    const p = prepared.reuse;
    return {
      paymentId: p.id,
      checkoutUrl: p.checkoutUrl ?? "",
      expiresAt: p.expiresAt ?? new Date(),
      amount: formatMoney(p.amount),
      currency: p.currency,
      reused: true,
    };
  }

  const { create: payment, shipment } = prepared;
  const metadata = { paymentId: payment.id, shipmentId: shipment.id, trackingId: shipment.trackingId };
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        allowed_payment_method_types: ["card"],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: PLATFORM_CURRENCY,
              unit_amount: toMinorUnits(payment.amount),
              product_data: {
                name: `Carrivo shipment ${shipment.trackingId}`,
                description: `${shipment.serviceType} delivery`,
              },
            },
          },
        ],
        client_reference_id: payment.id,
        customer_email: shipment.customer.email,
        metadata,
        payment_intent_data: { metadata },
        success_url: withQuery(env.FRONTEND_SUCCESS_URL, "session_id={CHECKOUT_SESSION_ID}"),
        cancel_url: withQuery(env.FRONTEND_CANCEL_URL, `shipmentId=${shipment.id}`),
        expires_at: Math.floor((Date.now() + CHECKOUT_TTL_MS) / 1000),
      },
      { idempotencyKey: `checkout-${payment.id}` },
    );
  } catch (error) {
    await prisma.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.FAILED, failureReason: `Checkout creation failed: ${errorText(error)}` },
    });
    // Stripe reports the minimum either as code amount_too_small or, with
    // allowed_payment_method_types, inside an invalid-payment-method message.
    if (
      error instanceof Stripe.errors.StripeError &&
      (error.code === "amount_too_small" || /at least \$?0\.50/i.test(error.message))
    ) {
      throw belowMinimum();
    }
    throw new ApiError(httpStatus.BAD_GATEWAY, "Could not start checkout with the payment provider, please try again");
  }

  if (!session.url) throw new ApiError(httpStatus.BAD_GATEWAY, "Payment provider returned no checkout URL");
  const expiresAt = new Date(session.expires_at * 1000);
  await prisma.payment.update({
    where: { id: payment.id },
    data: { stripeSessionId: session.id, checkoutUrl: session.url, expiresAt },
  });
  return {
    paymentId: payment.id,
    checkoutUrl: session.url,
    expiresAt,
    amount: formatMoney(payment.amount),
    currency: PLATFORM_CURRENCY,
    reused: false,
  };
};

// ───────── Mark paid (webhook + verify share this) ─────────

/**
 * Event-level idempotency: insert the event id; 0 rows means it was processed
 * before. Runs inside the handler's transaction, so if handling fails the event
 * row rolls back too and Stripe's retry is processed normally.
 * (createMany + skipDuplicates avoids a P2002 that would abort the transaction.)
 */
const recordEvent = async (db: Db, event: Stripe.Event | null, paymentId: string | null): Promise<boolean> => {
  if (!event) return true;
  const { count } = await db.stripeEvent.createMany({
    data: [{ id: event.id, type: event.type, paymentId }],
    skipDuplicates: true,
  });
  return count === 1;
};

/**
 * Marks a payment and its shipment PAID from a Checkout Session RETRIEVED from
 * Stripe (never from client input). Amount, currency and the shipment's current
 * price must match; otherwise the payment is flagged for review and NOT paid.
 * Guarded updates make every repeat (retries, /verify, duplicates) a no-op.
 */
const markPaidFromSession = (session: Stripe.Checkout.Session, event: Stripe.Event | null): Promise<WebhookOutcome> =>
  prisma.$transaction(async (tx) => {
    const paymentId = session.metadata?.["paymentId"] ?? null;
    if (!(await recordEvent(tx, event, paymentId))) return "duplicate_event";
    if (!paymentId) return "unknown_payment";

    const payment = await tx.payment.findFirst({
      where: { id: paymentId, stripeSessionId: session.id },
      select: { id: true, status: true, amount: true, shipmentId: true },
    });
    if (!payment) return "unknown_payment";
    if (session.status !== "complete" || session.payment_status !== "paid") return "not_paid";
    if (payment.status !== PaymentStatus.PENDING) return "already_processed";

    // Serialize with initiate and with any other payment for the same shipment.
    await tx.$queryRaw`SELECT "id" FROM "shipments" WHERE "id" = ${payment.shipmentId} FOR UPDATE`;
    const shipment = await tx.shipment.findUniqueOrThrow({
      where: { id: payment.shipmentId },
      select: { price: true, paymentStatus: true },
    });
    const paymentIntentId = stripeId(session.payment_intent);
    const check = checkPaidAmount({
      expectedAmount: payment.amount,
      shipmentPrice: shipment.price,
      sessionAmountTotal: session.amount_total,
      sessionCurrency: session.currency,
    });

    if (!check.ok) {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          requiresReview: true,
          reviewReason: check.reason,
          paidAmount: check.paidAmount,
          paidCurrency: session.currency,
          stripePaymentIntentId: paymentIntentId,
        },
      });
      await audit(tx, AUDIT_ACTIONS.PAYMENT_REVIEW_REQUIRED, payment.id, { reason: check.reason, sessionId: session.id });
      return "review_required";
    }

    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.PENDING },
      data: {
        status: PaymentStatus.PAID,
        paidAt: new Date(),
        paidAmount: check.paidAmount,
        paidCurrency: session.currency,
        stripePaymentIntentId: paymentIntentId,
        checkoutUrl: null,
        // An earlier card decline on this session no longer applies.
        failureReason: null,
      },
    });
    if (count === 0) return "already_processed";

    const shipmentUpdate = await tx.shipment.updateMany({
      where: { id: payment.shipmentId, paymentStatus: ShipmentPaymentStatus.UNPAID },
      data: { paymentStatus: ShipmentPaymentStatus.PAID },
    });
    if (shipmentUpdate.count === 0) {
      // Paid twice (e.g. two sessions). Keep the money record, flag it for an admin refund.
      await tx.payment.update({
        where: { id: payment.id },
        data: { requiresReview: true, reviewReason: `Duplicate payment: shipment was already ${shipment.paymentStatus}` },
      });
    }
    await audit(tx, AUDIT_ACTIONS.PAYMENT_PAID, payment.id, {
      sessionId: session.id,
      paymentIntentId,
      paidAmount: check.paidAmount,
      currency: session.currency,
      source: event ? "webhook" : "verify",
      duplicate: shipmentUpdate.count === 0,
    });
    return shipmentUpdate.count === 0 ? "review_required" : "paid";
  });

/** PENDING → EXPIRED or FAILED for a session (guarded; repeat calls are no-ops). */
const closePendingBySession = (
  sessionId: string,
  status: typeof PaymentStatus.EXPIRED | typeof PaymentStatus.FAILED,
  event: Stripe.Event | null,
  reason?: string,
): Promise<WebhookOutcome> =>
  prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({ where: { stripeSessionId: sessionId }, select: { id: true } });
    if (!(await recordEvent(tx, event, payment?.id ?? null))) return "duplicate_event";
    if (!payment) return "unknown_payment";
    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.PENDING },
      data: { status, checkoutUrl: null, ...(reason ? { failureReason: reason } : {}) },
    });
    if (count === 0) return "already_processed";
    await audit(tx, status === PaymentStatus.EXPIRED ? AUDIT_ACTIONS.PAYMENT_EXPIRED : AUDIT_ACTIONS.PAYMENT_FAILED, payment.id, {
      sessionId,
      reason: reason ?? null,
    });
    return status === PaymentStatus.EXPIRED ? "expired" : "failed";
  });

// ───────── Refunds ─────────

/**
 * Inside the cancel transaction: a PAID payment becomes REFUND_PENDING, so the
 * refund obligation is recorded atomically with the cancellation.
 */
const markRefundPendingForCancel = async (db: Db, shipmentId: string, actor: Actor, meta: RequestMeta): Promise<string | null> => {
  const payment = await db.payment.findFirst({
    where: { shipmentId, status: PaymentStatus.PAID },
    select: { id: true, amount: true },
  });
  if (!payment) return null;
  const { count } = await db.payment.updateMany({
    where: { id: payment.id, status: PaymentStatus.PAID },
    data: { status: PaymentStatus.REFUND_PENDING },
  });
  if (count === 0) return null;
  await audit(db, AUDIT_ACTIONS.PAYMENT_REFUND_REQUESTED, payment.id, { amount: payment.amount, reason: "shipment cancelled" }, actor, meta);
  return payment.id;
};

/** PAID/REFUND_PENDING → REFUNDED and the shipment's paymentStatus → REFUNDED (guarded). */
const completeRefund = async (
  db: Db,
  paymentId: string,
  details: { stripeRefundId: string | null; source: string; actor: Actor | null },
): Promise<boolean> => {
  const payment = await db.payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: { shipmentId: true, reviewReason: true },
  });
  const { count } = await db.payment.updateMany({
    where: { id: paymentId, status: { in: [PaymentStatus.PAID, PaymentStatus.REFUND_PENDING] } },
    data: {
      status: PaymentStatus.REFUNDED,
      refundedAt: new Date(),
      ...(details.stripeRefundId ? { stripeRefundId: details.stripeRefundId } : {}),
      // A previous refund failure is resolved now.
      ...(payment.reviewReason?.startsWith("Refund failed") ? { requiresReview: false, reviewReason: null } : {}),
    },
  });
  if (count === 0) return false;
  const shipment = await db.shipment.findUniqueOrThrow({ where: { id: payment.shipmentId }, select: { status: true } });
  await db.shipment.updateMany({
    where: { id: payment.shipmentId, paymentStatus: ShipmentPaymentStatus.PAID },
    data: { paymentStatus: ShipmentPaymentStatus.REFUNDED },
  });
  if (shipment.status !== ShipmentStatus.CANCELLED) {
    await db.payment.update({
      where: { id: paymentId },
      data: { requiresReview: true, reviewReason: `Refunded while the shipment is ${shipment.status}` },
    });
  }
  await audit(db, AUDIT_ACTIONS.PAYMENT_REFUNDED, paymentId, { stripeRefundId: details.stripeRefundId, source: details.source }, details.actor);
  return true;
};

/**
 * Carries out a REFUND_PENDING refund. Stripe call AFTER the DB commit, with a
 * fixed idempotency key, after checking for an existing refund first, so any
 * number of retries produce at most one refund. Failure leaves REFUND_PENDING +
 * requiresReview; nothing is half-applied.
 */
const processRefund = async (paymentId: string, actor: Actor | null): Promise<PaymentStatus> => {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, status: true, provider: true, amount: true, paidAmount: true, stripePaymentIntentId: true, shipmentId: true },
  });
  if (!payment) throw NOT_FOUND();
  if (payment.status !== PaymentStatus.REFUND_PENDING) return payment.status;

  if (payment.provider !== STRIPE_PROVIDER || !payment.stripePaymentIntentId) {
    // Seed/dev payments have no Stripe charge to refund: completed locally, audited as such.
    await prisma.$transaction((tx) =>
      completeRefund(tx, payment.id, { stripeRefundId: null, source: `local (${payment.provider} payment, no Stripe charge)`, actor }),
    );
    return PaymentStatus.REFUNDED;
  }

  try {
    const existing = await stripe.refunds.list({ payment_intent: payment.stripePaymentIntentId, limit: 10 });
    const reusable = existing.data.find((r) => r.status === "succeeded" || r.status === "pending" || r.status === "requires_action");
    const refund =
      reusable ??
      (await stripe.refunds.create(
        {
          payment_intent: payment.stripePaymentIntentId,
          amount: toMinorUnits(payment.paidAmount ?? payment.amount),
          reason: "requested_by_customer",
          metadata: { paymentId: payment.id, shipmentId: payment.shipmentId },
        },
        { idempotencyKey: `refund-${payment.id}` },
      ));
    if (refund.status === "succeeded") {
      await prisma.$transaction((tx) => completeRefund(tx, payment.id, { stripeRefundId: refund.id, source: "stripe", actor }));
      return PaymentStatus.REFUNDED;
    }
    await prisma.payment.update({ where: { id: payment.id }, data: { stripeRefundId: refund.id } });
    return PaymentStatus.REFUND_PENDING; // charge.refunded completes it
  } catch (error) {
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: { requiresReview: true, reviewReason: `Refund failed: ${errorText(error)}` },
      });
      await audit(tx, AUDIT_ACTIONS.PAYMENT_REFUND_FAILED, payment.id, { error: errorText(error) }, actor);
    });
    return PaymentStatus.REFUND_PENDING;
  }
};

/** Admin: retry a REFUND_PENDING refund (same idempotency key, so never double). */
const retryRefund = async (actor: Actor, paymentId: string): Promise<PaymentDto> => {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, select: { status: true } });
  if (!payment) throw NOT_FOUND();
  if (payment.status !== PaymentStatus.REFUND_PENDING) {
    throw conflict(`Only REFUND_PENDING payments can be refunded here (current status: ${payment.status})`);
  }
  await processRefund(paymentId, actor);
  return getById(actor, paymentId);
};

// ───────── Webhook dispatch ─────────

const paymentByIntent = (db: Db, paymentIntentId: string | null) =>
  paymentIntentId
    ? db.payment.findFirst({ where: { stripePaymentIntentId: paymentIntentId }, select: { id: true, status: true } })
    : Promise.resolve(null);

/**
 * Handles a VERIFIED Stripe event. Checkout events are only a trigger: the
 * session is re-retrieved from Stripe (authoritative, our pinned API version).
 * Unknown event types return "ignored" without touching the database.
 */
const handleWebhookEvent = async (event: Stripe.Event): Promise<WebhookOutcome> => {
  if (!isHandledStripeEvent(event.type)) return "ignored";

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = await stripe.checkout.sessions.retrieve(event.data.object.id);
      return markPaidFromSession(session, event);
    }
    case "checkout.session.expired":
      return closePendingBySession(event.data.object.id, PaymentStatus.EXPIRED, event);
    case "checkout.session.async_payment_failed":
      return closePendingBySession(event.data.object.id, PaymentStatus.FAILED, event, "Asynchronous payment failed");
    case "payment_intent.payment_failed": {
      // Card declined inside Checkout: the customer can retry on the same session,
      // so only the reason is recorded and the payment stays PENDING.
      const intent = event.data.object;
      const paymentId = intent.metadata["paymentId"] ?? null;
      return prisma.$transaction(async (tx) => {
        if (!(await recordEvent(tx, event, paymentId))) return "duplicate_event";
        if (!paymentId) return "unknown_payment";
        const { count } = await tx.payment.updateMany({
          where: { id: paymentId, status: PaymentStatus.PENDING },
          data: { failureReason: (intent.last_payment_error?.message ?? "Payment failed").slice(0, 500) },
        });
        return count === 0 ? "already_processed" : "error_recorded";
      });
    }
    case "charge.refunded": {
      const charge = event.data.object;
      return prisma.$transaction(async (tx) => {
        const payment = await paymentByIntent(tx, stripeId(charge.payment_intent));
        if (!(await recordEvent(tx, event, payment?.id ?? null))) return "duplicate_event";
        if (!payment) return "unknown_payment";
        if (!charge.refunded) {
          await tx.payment.update({
            where: { id: payment.id },
            data: { requiresReview: true, reviewReason: `Partial refund of ${formatMoney(charge.amount_refunded / 100)} made outside the app` },
          });
          return "review_required";
        }
        const done = await completeRefund(tx, payment.id, { stripeRefundId: null, source: "webhook charge.refunded", actor: null });
        return done ? "refunded" : "already_processed";
      });
    }
    case "refund.failed": {
      const refund = event.data.object;
      return prisma.$transaction(async (tx) => {
        const payment = await paymentByIntent(tx, stripeId(refund.payment_intent));
        if (!(await recordEvent(tx, event, payment?.id ?? null))) return "duplicate_event";
        if (!payment) return "unknown_payment";
        const reason = `Refund failed: ${refund.failure_reason ?? "unknown reason"}`;
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            requiresReview: true,
            reviewReason: reason,
            // Money is back with us: the refund is still owed (admin can retry).
            ...(payment.status === PaymentStatus.REFUNDED ? { status: PaymentStatus.REFUND_PENDING, refundedAt: null } : {}),
          },
        });
        await audit(tx, AUDIT_ACTIONS.PAYMENT_REFUND_FAILED, payment.id, { refundId: refund.id, reason });
        return "refund_failed_recorded";
      });
    }
    default:
      return "ignored";
  }
};

// ───────── Verify (success page) ─────────

/**
 * The success page passes ?session_id=cs_... The id is only a lookup key: it must
 * belong to the caller's payment, and the real status comes from Stripe. A paid
 * session is reconciled here too (covers a missed or delayed webhook).
 */
const verify = async (viewer: Actor, sessionId: string): Promise<VerifyResult> => {
  const payment = await prisma.payment.findFirst({
    where: { stripeSessionId: sessionId, ...(viewer.role === Role.ADMIN ? {} : { userId: viewer.id }) },
    select: { id: true },
  });
  if (!payment) throw NOT_FOUND();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.status === "complete" && session.payment_status === "paid") {
    await markPaidFromSession(session, null);
  } else if (session.status === "expired") {
    await closePendingBySession(session.id, PaymentStatus.EXPIRED, null);
  }
  return {
    payment: await getById(viewer, payment.id),
    stripe: { sessionStatus: session.status, paymentStatus: session.payment_status },
  };
};

/** Count of PENDING payments whose checkout may still be paid (blocks re-pricing). */
const hasOpenPayment = async (db: Db, shipmentId: string): Promise<boolean> =>
  (await db.payment.count({
    where: {
      shipmentId,
      status: PaymentStatus.PENDING,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  })) > 0;

export const PaymentService = {
  initiate,
  verify,
  getById,
  listMine,
  adminList,
  handleWebhookEvent,
  markRefundPendingForCancel,
  processRefund,
  retryRefund,
  hasOpenPayment,
};
