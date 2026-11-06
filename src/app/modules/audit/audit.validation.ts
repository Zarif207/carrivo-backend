import { z } from "zod";
import { optionalQuery, paginationQueryShape } from "../../utils/pagination.js";
import { dateQuery } from "../shipment/shipment.validation.js";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "./audit.constants.js";

const actions = Object.values(AUDIT_ACTIONS) as [string, ...string[]];
const entities = Object.values(AUDIT_ENTITIES) as [string, ...string[]];

// Newest first by default; only createdAt is sortable (the indexes are (filter, createdAt)).
const list = z.object({
  query: z
    .strictObject({
      page: paginationQueryShape.page,
      limit: paginationQueryShape.limit,
      sortOrder: paginationQueryShape.sortOrder,
      actorId: optionalQuery(z.uuid({ message: "Invalid actor id" })),
      action: optionalQuery(z.enum(actions, { message: "Unknown audit action" })),
      entityType: optionalQuery(z.enum(entities, { message: "Unknown entity type" })),
      entityId: optionalQuery(z.string().trim().min(1).max(100)),
      fromDate: dateQuery("start"),
      toDate: dateQuery("end"),
    })
    .refine((q) => !q.fromDate || !q.toDate || q.fromDate <= q.toDate, {
      message: "fromDate must be on or before toDate",
      path: ["fromDate"],
    }),
});

export const AuditValidation = { list };

export type AuditLogQuery = z.infer<typeof list>["query"];
