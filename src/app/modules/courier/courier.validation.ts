import { z } from "zod";
import { EarningStatus, ShipmentStatus } from "../../../generated/prisma/enums.js";
import { booleanQuery, optionalQuery, paginationQueryShape, sortByQuery } from "../../utils/pagination.js";
import { dateQuery } from "../shipment/shipment.validation.js";

export const COURIER_SORT_FIELDS = ["name", "createdAt"] as const;
export const TASK_SORT_FIELDS = ["createdAt", "updatedAt", "status"] as const;
export const EARNING_SORT_FIELDS = ["createdAt", "amount"] as const;

const uuid = (label: string) => z.uuid({ message: `Invalid ${label}` });

const list = z.object({
  query: z.strictObject({
    ...paginationQueryShape,
    sortBy: sortByQuery(COURIER_SORT_FIELDS, "name"),
    zoneId: optionalQuery(uuid("zone id")),
    hubId: optionalQuery(uuid("hub id")),
    available: optionalQuery(booleanQuery),
  }),
});

const tasks = z.object({
  query: z.strictObject({
    ...paginationQueryShape,
    sortBy: sortByQuery(TASK_SORT_FIELDS, "updatedAt"),
    // Omitted: active tasks only (not DELIVERED / RETURNED / CANCELLED).
    status: optionalQuery(z.enum(ShipmentStatus)),
  }),
});

const dateRange = (q: { fromDate?: Date | undefined; toDate?: Date | undefined }): boolean =>
  !q.fromDate || !q.toDate || q.fromDate <= q.toDate;

const earnings = z.object({
  query: z
    .strictObject({
      ...paginationQueryShape,
      sortBy: sortByQuery(EARNING_SORT_FIELDS, "createdAt"),
      status: optionalQuery(z.enum(EarningStatus)),
      fromDate: dateQuery("start"),
      toDate: dateQuery("end"),
    })
    .refine(dateRange, { message: "fromDate must be on or before toDate", path: ["fromDate"] }),
});

const availability = z.object({
  body: z.strictObject({ isAvailable: z.boolean({ message: "isAvailable must be true or false" }) }),
});

export const CourierValidation = { list, tasks, earnings, availability };

export type CourierListQuery = z.infer<typeof list>["query"];
export type CourierTaskQuery = z.infer<typeof tasks>["query"];
export type CourierEarningQuery = z.infer<typeof earnings>["query"];
export type AvailabilityInput = z.infer<typeof availability>["body"];
