/** Courier-application rules in one place (business constants, not env). */

/** Days a rejected applicant waits before they may apply again. */
export const REAPPLY_COOLDOWN_DAYS = 7;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Text caps; the migration's CHECK constraint enforces the same numbers. */
export const APPLICATION_LIMITS = {
  vehiclePlate: 20,
  experience: 500,
  about: 1000,
  reviewNote: 500,
} as const;

/** Applications returned in GET /courier-applications/my (newest first). */
export const MY_HISTORY_LIMIT = 20;

export const ADMIN_APPLICATION_SORT_FIELDS = ["createdAt", "updatedAt", "status"] as const;
