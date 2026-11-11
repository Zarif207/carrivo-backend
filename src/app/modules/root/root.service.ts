import packageJson from "../../../../package.json" with { type: "json" };
import { AUTH_BASE_PATH } from "../../lib/auth.js";
import { moduleRoutes } from "../../routes/index.js";
import type { ApiInfo } from "./root.types.js";

/** Every versioned route lives under this prefix (app.ts mounts the router here). */
export const API_BASE_PATH = "/api/v1";

/** The public API reference (docs/api.md on the default branch). */
export const API_DOCS_URL = "https://github.com/Zarif207/carrivo-backend/blob/main/docs/api.md";

/** A base path from the mount table (routes/index.ts), so the list can't drift from the real routes. */
const mounted = (path: string): string => {
  if (!moduleRoutes.some((route) => route.path === path)) throw new Error(`No module is mounted at ${path}`);
  return `${API_BASE_PATH}${path}`;
};

/** Built once at startup: constants and the mount table only. */
const ENDPOINTS: ApiInfo["endpoints"] = {
  auth: AUTH_BASE_PATH,
  users: mounted("/users"),
  shipments: mounted("/shipments"),
  payments: mounted("/payments"),
  zones: mounted("/zones"),
  hubs: mounted("/hubs"),
  pricing: mounted("/pricing"),
  notifications: mounted("/notifications"),
  courierApplications: mounted("/courier-applications"),
  tracking: mounted("/tracking"),
  admin: mounted("/admin"),
};
const HEALTH_PATH = mounted("/health");

/**
 * What GET / and GET /api/v1 answer. No database, Redis or env values beyond a two-way environment
 * label, so it answers fast and keeps answering while the database is down (GET /health checks that).
 */
const getInfo = (nodeEnv: string | undefined, now: Date): ApiInfo => ({
  name: "Carrivo API",
  version: packageJson.version,
  status: "ok",
  environment: nodeEnv === "production" ? "production" : "development",
  docs: API_DOCS_URL,
  health: HEALTH_PATH,
  endpoints: ENDPOINTS,
  timestamp: now.toISOString(),
});

export const RootService = { getInfo };
