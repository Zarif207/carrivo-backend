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
} as const;

/** Joins an origin (no trailing slash) and a path from FRONTEND_PATHS. */
export const joinFrontendUrl = (origin: string, path: string): string => `${origin.replace(/\/+$/, "")}${path}`;
