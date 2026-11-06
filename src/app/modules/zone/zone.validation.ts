import { z } from "zod";
import { idParams } from "../../utils/commonValidation.js";
import { booleanQuery, optionalQuery, paginationQueryShape, sortByQuery } from "../../utils/pagination.js";

export const ZONE_SORT_FIELDS = ["name", "code", "createdAt"] as const;

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,20}$/, { message: "Code must be 2-20 characters: letters, digits or dashes" });

const zoneBody = z.strictObject({
  name: z.string().trim().min(2, { message: "Name must be at least 2 characters" }).max(100),
  code,
  description: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
});

const create = z.object({ body: zoneBody });

const update = z.object({
  params: idParams,
  body: zoneBody.partial().refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update: name, code, description, isActive",
  }),
});

const list = z.object({
  query: z.strictObject({
    ...paginationQueryShape,
    sortBy: sortByQuery(ZONE_SORT_FIELDS, "createdAt"),
    // Defaults to active zones only; `all` includes inactive ones.
    isActive: optionalQuery(z.union([booleanQuery, z.literal("all")])).transform((v) => v ?? true),
  }),
});

const byId = z.object({ params: idParams });

export const ZoneValidation = { create, update, list, byId };

export type CreateZoneInput = z.infer<typeof create>["body"];
export type UpdateZoneInput = z.infer<typeof update>["body"];
export type ZoneListQuery = z.infer<typeof list>["query"];
