import { Role } from "../../generated/prisma/enums.js";

/*
 * Role policy in one place.
 * - STAFF_ROLES may READ everything an admin can read (route guards + service scoping).
 * - READ_ONLY_ROLES may never change anything: authenticate() rejects their mutating requests
 *   (middlewares/readOnly.ts), so a new route can't forget the rule.
 * - ASSIGNABLE_ROLES are the only roles the admin API can grant; ADMIN_VIEWER is seed-only.
 */

export const STAFF_ROLES: readonly Role[] = [Role.ADMIN, Role.ADMIN_VIEWER];
export const READ_ONLY_ROLES: readonly Role[] = [Role.ADMIN_VIEWER];
export const ASSIGNABLE_ROLES = [Role.CUSTOMER, Role.COURIER, Role.ADMIN] as const;

/** True for roles that see every record an admin sees (reads only for ADMIN_VIEWER). */
export const isStaff = (role: Role): boolean => STAFF_ROLES.includes(role);
export const isReadOnlyRole = (role: Role): boolean => READ_ONLY_ROLES.includes(role);
