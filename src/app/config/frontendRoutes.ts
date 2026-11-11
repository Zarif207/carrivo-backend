/**
 * EVERY frontend path the API links or redirects to. Change a path here to match
 * the Next.js routes; nothing else in the backend hard-codes a frontend path.
 * The origin comes from FRONTEND_URL. (Stripe's success/cancel pages are full URLs
 * in FRONTEND_SUCCESS_URL / FRONTEND_CANCEL_URL.)
 *
 * Deliberately has no env import, so pure code (e.g. the email builder) can use it in unit tests.
 */
export const FRONTEND_PATHS = {
  /** Customer (and admin) shipment detail page. */
  customerShipment: (shipmentId: string): string => `/shipments/${encodeURIComponent(shipmentId)}`,
  /** Courier task page. */
  courierTask: (shipmentId: string): string => `/courier/tasks/${encodeURIComponent(shipmentId)}`,
  /** Where Google sign-in lands with ?code=... or ?error=... */
  googleCallback: "/auth/google/callback",
  /** Admin shipment detail (src/app/admin/shipments/[id]). */
  adminShipment: (shipmentId: string): string => `/admin/shipments/${encodeURIComponent(shipmentId)}`,
  /** Admin payments list, optionally filtered (src/app/admin/payments reads ?status= and ?requiresReview=true). */
  adminPayments: (filter?: { status?: string; requiresReview?: boolean }): string => {
    const params = new URLSearchParams();
    if (filter?.status) params.set("status", filter.status);
    if (filter?.requiresReview) params.set("requiresReview", "true");
    const query = params.toString();
    return query ? `/admin/payments?${query}` : "/admin/payments";
  },
  /** Admin settings tab (src/app/admin/settings reads ?tab=zones|hubs|pricing). */
  adminSettings: (tab: "zones" | "hubs" | "pricing"): string => `/admin/settings?tab=${tab}`,
  /** Admin user management (src/app/admin/users). */
  adminUsers: "/admin/users",
  /** Admin courier-application queue, optionally filtered (?status=PENDING). */
  adminCourierApplications: (filter?: { status?: string }): string =>
    filter?.status ? `/admin/courier-applications?status=${encodeURIComponent(filter.status)}` : "/admin/courier-applications",
  /** Customer page with their courier application (status, review note, reapply date). */
  courierApplication: "/courier-application",
  /** Signed-in home; the frontend sends each role to its own dashboard (a new courier lands on /courier). */
  dashboard: "/dashboard",
  /**
   * Admin notification feed. NOT a frontend page yet: only the fallback for a staff
   * notice with no better target (no event uses it today).
   */
  adminNotifications: "/admin/notifications",
} as const;

/** Joins an origin (no trailing slash) and a path from FRONTEND_PATHS. */
export const joinFrontendUrl = (origin: string, path: string): string => `${origin.replace(/\/+$/, "")}${path}`;
