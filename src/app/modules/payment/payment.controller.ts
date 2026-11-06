import httpStatus from "http-status";
import type Stripe from "stripe";
import { env } from "../../config/env.js";
import { stripe } from "../../lib/stripe.js";
import { getAuthUser } from "../../middlewares/authenticate.js";
import { getValidatedQuery } from "../../middlewares/validateRequest.js";
import type { ErrorResponse } from "../../types/response.types.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { getRequestMeta } from "../../utils/requestMeta.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { PaymentService } from "./payment.service.js";
import type { AdminPaymentsQuery, InitiateInput, MyPaymentsQuery, VerifyQuery } from "./payment.validation.js";

const initiate = catchAsync(async (req, res) => {
  const data = await PaymentService.initiate(getAuthUser(req), (req.body as InitiateInput).shipmentId, getRequestMeta(req));
  sendResponse(res, {
    statusCode: data.reused ? httpStatus.OK : httpStatus.CREATED,
    message: data.reused ? "Existing checkout session returned" : "Checkout session created",
    data,
  });
});

const verify = catchAsync(async (req, res) => {
  const { session_id } = getValidatedQuery<VerifyQuery>(res);
  const data = await PaymentService.verify(getAuthUser(req), session_id);
  sendResponse(res, { statusCode: httpStatus.OK, message: "Payment status verified with Stripe", data });
});

const listMine = catchAsync(async (req, res) => {
  const { data, meta } = await PaymentService.listMine(getAuthUser(req), getValidatedQuery<MyPaymentsQuery>(res));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Payments retrieved successfully", data, meta });
});

const getById = catchAsync(async (req, res) => {
  const data = await PaymentService.getById(getAuthUser(req), String(req.params["id"]));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Payment retrieved successfully", data });
});

const adminList = catchAsync(async (req, res) => {
  const { data, meta } = await PaymentService.adminList(getAuthUser(req), getValidatedQuery<AdminPaymentsQuery>(res));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Payments retrieved successfully", data, meta });
});

const retryRefund = catchAsync(async (req, res) => {
  const data = await PaymentService.retryRefund(getAuthUser(req), String(req.params["id"]));
  sendResponse(res, { statusCode: httpStatus.OK, message: `Refund ${data.status === "REFUNDED" ? "completed" : "still pending"}`, data });
});

/**
 * Stripe webhook. Mounted with express.raw (see app.ts): the signature is computed
 * over the exact raw bytes, so the body must not be parsed first.
 * 400 on a bad signature; 500 on a processing error (Stripe retries); otherwise 200.
 */
const webhook = catchAsync(async (req, res) => {
  const signature = req.headers["stripe-signature"];
  let event: Stripe.Event;
  try {
    if (typeof signature !== "string" || !Buffer.isBuffer(req.body)) throw new Error("missing signature or raw body");
    event = stripe.webhooks.constructEvent(req.body, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    const body: ErrorResponse = { success: false, message: "Invalid Stripe signature", errors: [] };
    res.status(httpStatus.BAD_REQUEST).json(body);
    return;
  }
  const outcome = await PaymentService.handleWebhookEvent(event);
  sendResponse(res, { statusCode: httpStatus.OK, message: "Webhook received", data: { eventId: event.id, type: event.type, outcome } });
});

export const PaymentController = { initiate, verify, listMine, getById, adminList, retryRefund, webhook };
