import { z } from "zod";
import { ServiceType, ShipmentPaymentStatus, ShipmentStatus } from "../../../generated/prisma/enums.js";
import { idParams, moneySchema, phoneSchema, weightSchema } from "../../utils/commonValidation.js";
import { optionalQuery, paginationQueryShape, sortByQuery } from "../../utils/pagination.js";
import { BUSINESS_UTC_OFFSET, SHIPMENT_SORT_FIELDS } from "./shipment.constants.js";

const name = z.string().trim().min(2, { message: "Name must be at least 2 characters" }).max(100);
const address = z.string().trim().min(5, { message: "Address must be at least 5 characters" }).max(300);
const uuid = (label: string) => z.uuid({ message: `Invalid ${label}` });

/** Fields a customer may edit while the shipment is PENDING (zones/hubs are fixed). */
const editableFields = {
  senderName: name,
  senderPhone: phoneSchema,
  pickupAddress: address,
  receiverName: name,
  receiverPhone: phoneSchema,
  receiverEmail: z.email({ message: "Invalid receiver email" }).trim().toLowerCase().nullable(),
  deliveryAddress: address,
  description: z.string().trim().max(500).nullable(),
  declaredValue: moneySchema.nullable(),
  isFragile: z.boolean(),
  weightKg: weightSchema,
  serviceType: z.enum(ServiceType, { message: "serviceType must be STANDARD, EXPRESS or SAME_DAY" }),
};

// Strict: a client-sent price, status, trackingId or customerId is rejected with 400.
const create = z.object({
  body: z.strictObject({
    ...editableFields,
    receiverEmail: editableFields.receiverEmail.optional(),
    description: editableFields.description.optional(),
    declaredValue: editableFields.declaredValue.optional(),
    isFragile: editableFields.isFragile.optional(),
    originZoneId: uuid("origin zone id"),
    originHubId: uuid("origin hub id"),
    destinationZoneId: uuid("destination zone id"),
    destinationHubId: uuid("destination hub id"),
  }),
});

const update = z.object({
  params: idParams,
  body: z
    .strictObject(editableFields)
    .partial()
    .refine((body) => Object.keys(body).length > 0, { message: "Provide at least one field to update" }),
});

const cancel = z.object({
  params: idParams,
  body: z.strictObject({ reason: z.string().trim().min(3).max(500).optional() }).optional(),
});

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD (taken as a Dhaka calendar day) or a full ISO datetime with offset. */
const dateQuery = (edge: "start" | "end") =>
  optionalQuery(z.union([z.iso.date(), z.iso.datetime({ offset: true })])).transform((value) => {
    if (value === undefined) return undefined;
    if (!DATE_ONLY.test(value)) return new Date(value);
    const time = edge === "start" ? "00:00:00.000" : "23:59:59.999";
    return new Date(`${value}T${time}${BUSINESS_UTC_OFFSET}`);
  });

const list = z.object({
  query: z
    .strictObject({
      ...paginationQueryShape,
      sortBy: sortByQuery(SHIPMENT_SORT_FIELDS, "createdAt"),
      status: optionalQuery(z.enum(ShipmentStatus)),
      serviceType: optionalQuery(z.enum(ServiceType)),
      paymentStatus: optionalQuery(z.enum(ShipmentPaymentStatus)),
      fromDate: dateQuery("start"),
      toDate: dateQuery("end"),
      // Admin-only narrowing; for customers/couriers the role scope is always applied on top.
      customerId: optionalQuery(uuid("customer id")),
      courierId: optionalQuery(uuid("courier id")),
    })
    .refine((q) => !q.fromDate || !q.toDate || q.fromDate <= q.toDate, {
      message: "fromDate must be on or before toDate",
      path: ["fromDate"],
    }),
});

const byId = z.object({ params: idParams });

export const ShipmentValidation = { create, update, cancel, list, byId };

export type CreateShipmentInput = z.infer<typeof create>["body"];
export type UpdateShipmentInput = z.infer<typeof update>["body"];
export type CancelShipmentInput = z.infer<typeof cancel>["body"];
export type ShipmentListQuery = z.infer<typeof list>["query"];
