import { z } from "zod";
import { idParams, phoneSchema } from "../../utils/commonValidation.js";
import { booleanQuery, optionalQuery, paginationQueryShape, sortByQuery } from "../../utils/pagination.js";

export const HUB_SORT_FIELDS = ["name", "code", "city", "createdAt"] as const;

const hubBody = z.strictObject({
  name: z.string().trim().min(2, { message: "Name must be at least 2 characters" }).max(100),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,30}$/, { message: "Code must be 2-30 characters: letters, digits or dashes" }),
  address: z.string().trim().min(3).max(300),
  city: z.string().trim().min(2).max(100),
  phone: phoneSchema.nullable().optional(),
  zoneId: z.uuid({ message: "Invalid zone id" }),
  isActive: z.boolean().optional(),
});

const create = z.object({ body: hubBody });

const update = z.object({
  params: idParams,
  body: hubBody.partial().refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update",
  }),
});

const list = z.object({
  query: z.strictObject({
    ...paginationQueryShape,
    sortBy: sortByQuery(HUB_SORT_FIELDS, "createdAt"),
    zoneId: optionalQuery(z.uuid({ message: "Invalid zone id" })),
    city: optionalQuery(z.string().trim().min(1).max(100)),
    isActive: optionalQuery(z.union([booleanQuery, z.literal("all")])).transform((v) => v ?? true),
  }),
});

const byId = z.object({ params: idParams });

export const HubValidation = { create, update, list, byId };

export type CreateHubInput = z.infer<typeof create>["body"];
export type UpdateHubInput = z.infer<typeof update>["body"];
export type HubListQuery = z.infer<typeof list>["query"];
