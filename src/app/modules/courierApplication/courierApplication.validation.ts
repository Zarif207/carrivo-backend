import { z } from "zod";
import { CourierApplicationStatus, VehicleType, WorkAvailability } from "../../../generated/prisma/enums.js";
import { idParams, phoneSchema } from "../../utils/commonValidation.js";
import { optionalQuery, paginationQueryShape, sortByQuery } from "../../utils/pagination.js";
import { ADMIN_APPLICATION_SORT_FIELDS, APPLICATION_LIMITS } from "./courierApplication.constants.js";

/** Optional free text: trimmed, "" counts as not given (stored as null). */
const optionalText = (max: number, field: string) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().max(max, { message: `${field} must be at most ${max} characters` }).nullable().optional(),
  );

/*
 * Strict object: unknown keys are refused, so nobody can send a driver licence number, SSN or any
 * other government ID (we never collect them).
 */
const apply = z.object({
  body: z.strictObject({
    phone: phoneSchema,
    preferredZoneId: z.uuid({ message: "Invalid zone id" }).nullable().optional(),
    vehicleType: z.enum(VehicleType, { message: `vehicleType must be one of: ${Object.values(VehicleType).join(", ")}` }),
    vehiclePlate: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? null : value),
      z
        .string()
        .trim()
        .toUpperCase()
        .min(2, { message: "Plate must be at least 2 characters" })
        .max(APPLICATION_LIMITS.vehiclePlate, { message: `Plate must be at most ${APPLICATION_LIMITS.vehiclePlate} characters` })
        .regex(/^[A-Z0-9][A-Z0-9 -]*$/, { message: "Plate may contain letters, digits, spaces and dashes" })
        .nullable()
        .optional(),
    ),
    availability: z.enum(WorkAvailability, { message: `availability must be one of: ${Object.values(WorkAvailability).join(", ")}` }),
    experience: optionalText(APPLICATION_LIMITS.experience, "experience"),
    about: optionalText(APPLICATION_LIMITS.about, "about"),
  }),
});

const byId = z.object({ params: idParams });

const adminList = z.object({
  query: z.strictObject({
    ...paginationQueryShape,
    sortBy: sortByQuery(ADMIN_APPLICATION_SORT_FIELDS, "createdAt"),
    status: optionalQuery(z.enum(CourierApplicationStatus)),
    zoneId: optionalQuery(z.uuid({ message: "Invalid zone id" })),
    vehicleType: optionalQuery(z.enum(VehicleType)),
  }),
});

/** Optional overrides: the zone defaults to the applicant's preferred zone (required if they gave none). */
const approve = z.object({
  params: idParams,
  body: z
    .strictObject({
      zoneId: z.uuid({ message: "Invalid zone id" }).optional(),
      hubId: z.uuid({ message: "Invalid hub id" }).nullable().optional(),
    })
    .optional()
    .transform((body) => body ?? {}),
});

const reject = z.object({
  params: idParams,
  body: z.strictObject({
    note: z
      .string({ message: "A note explaining the decision is required" })
      .trim()
      .min(3, { message: "A note explaining the decision is required (at least 3 characters)" })
      .max(APPLICATION_LIMITS.reviewNote, { message: `note must be at most ${APPLICATION_LIMITS.reviewNote} characters` }),
  }),
});

export const CourierApplicationValidation = { apply, byId, adminList, approve, reject };

export type ApplyInput = z.infer<typeof apply>["body"];
export type AdminApplicationListQuery = z.infer<typeof adminList>["query"];
export type ApproveInput = z.infer<typeof approve>["body"];
export type RejectInput = z.infer<typeof reject>["body"];
