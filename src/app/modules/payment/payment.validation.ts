import { z } from "zod";
import { PaymentStatus } from "../../../generated/prisma/enums.js";
import { booleanQuery, optionalQuery, paginationQueryShape, sortByQuery } from "../../utils/pagination.js";
import { idParams } from "../../utils/commonValidation.js";
import { dateQuery } from "../shipment/shipment.validation.js";

export const PAYMENT_SORT_FIELDS = ["createdAt", "amount", "paidAt", "status"] as const;

const initiate = z.object({
  body: z.strictObject({ shipmentId: z.uuid({ message: "Invalid shipment id" }) }),
});

const verify = z.object({
  query: z.strictObject({
    session_id: z.string().trim().regex(/^cs_(test|live)_[A-Za-z0-9]+$/, { message: "session_id must be a Stripe Checkout Session id" }),
  }),
});

const dateRange = (q: { fromDate?: Date | undefined; toDate?: Date | undefined }): boolean =>
  !q.fromDate || !q.toDate || q.fromDate <= q.toDate;

const listMine = z.object({
  query: z.strictObject({
    page: paginationQueryShape.page,
    limit: paginationQueryShape.limit,
    sortOrder: paginationQueryShape.sortOrder,
    sortBy: sortByQuery(PAYMENT_SORT_FIELDS, "createdAt"),
    status: optionalQuery(z.enum(PaymentStatus)),
  }),
});

const adminList = z.object({
  query: z
    .strictObject({
      page: paginationQueryShape.page,
      limit: paginationQueryShape.limit,
      sortOrder: paginationQueryShape.sortOrder,
      sortBy: sortByQuery(PAYMENT_SORT_FIELDS, "createdAt"),
      status: optionalQuery(z.enum(PaymentStatus)),
      customerId: optionalQuery(z.uuid({ message: "Invalid customer id" })),
      shipmentId: optionalQuery(z.uuid({ message: "Invalid shipment id" })),
      requiresReview: optionalQuery(booleanQuery),
      fromDate: dateQuery("start"),
      toDate: dateQuery("end"),
    })
    .refine(dateRange, { message: "fromDate must be on or before toDate", path: ["fromDate"] }),
});

const byId = z.object({ params: idParams });

export const PaymentValidation = { initiate, verify, listMine, adminList, byId };

export type InitiateInput = z.infer<typeof initiate>["body"];
export type VerifyQuery = z.infer<typeof verify>["query"];
export type MyPaymentsQuery = z.infer<typeof listMine>["query"];
export type AdminPaymentsQuery = z.infer<typeof adminList>["query"];
