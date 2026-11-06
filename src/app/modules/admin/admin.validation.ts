import { z } from "zod";
import { Role, UserStatus, VehicleType } from "../../../generated/prisma/enums.js";
import { idParams, phoneSchema } from "../../utils/commonValidation.js";
import { optionalQuery, paginationQueryShape, sortByQuery } from "../../utils/pagination.js";

export const ADMIN_USER_SORT_FIELDS = ["name", "email", "createdAt", "role", "status"] as const;

const courierProfile = z.strictObject({
  zoneId: z.uuid({ message: "Invalid zone id" }),
  hubId: z.uuid({ message: "Invalid hub id" }).nullable().optional(),
  vehicleType: z.enum(VehicleType, { message: `vehicleType must be one of: ${Object.values(VehicleType).join(", ")}` }),
  vehicleNumber: z.string().trim().min(2).max(50).nullable().optional(),
  licenseNumber: z.string().trim().min(2).max(50).nullable().optional(),
});

const listUsers = z.object({
  query: z.strictObject({
    ...paginationQueryShape,
    sortBy: sortByQuery(ADMIN_USER_SORT_FIELDS, "createdAt"),
    role: optionalQuery(z.enum(Role)),
    status: optionalQuery(z.enum(UserStatus)),
  }),
});

// Customers self-register; admins create staff only.
const createUser = z.object({
  body: z
    .strictObject({
      name: z.string().trim().min(2, { message: "Name must be at least 2 characters" }).max(100),
      email: z.email({ message: "A valid email is required" }).trim().toLowerCase(),
      password: z.string().min(8, { message: "Password must be at least 8 characters" }).max(128),
      phone: phoneSchema.optional(),
      role: z.enum([Role.COURIER, Role.ADMIN], { message: "role must be COURIER or ADMIN (customers self-register)" }),
      courierProfile: courierProfile.optional(),
    })
    .superRefine((body, ctx) => {
      if (body.role === Role.COURIER && !body.courierProfile) {
        ctx.addIssue({ code: "custom", path: ["courierProfile"], message: "courierProfile is required for a COURIER" });
      }
      if (body.role === Role.ADMIN && body.courierProfile) {
        ctx.addIssue({ code: "custom", path: ["courierProfile"], message: "courierProfile is only allowed for a COURIER" });
      }
    }),
});

const changeRole = z.object({
  params: idParams,
  body: z
    .strictObject({ role: z.enum(Role), courierProfile: courierProfile.optional() })
    .superRefine((body, ctx) => {
      if (body.courierProfile && body.role !== Role.COURIER) {
        ctx.addIssue({ code: "custom", path: ["courierProfile"], message: "courierProfile is only allowed when role is COURIER" });
      }
    }),
});

const changeStatus = z.object({
  params: idParams,
  body: z.strictObject({
    status: z.enum(UserStatus),
    reason: z.string().trim().min(3).max(500).optional(),
  }),
});

export const AdminValidation = { listUsers, createUser, changeRole, changeStatus };

export type AdminUserListQuery = z.infer<typeof listUsers>["query"];
export type CreateUserInput = z.infer<typeof createUser>["body"];
export type CourierProfileInput = z.infer<typeof courierProfile>;
export type ChangeRoleInput = z.infer<typeof changeRole>["body"];
export type ChangeStatusInput = z.infer<typeof changeStatus>["body"];
