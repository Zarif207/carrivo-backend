import { Router } from "express";
import { AdminRoutes } from "../modules/admin/admin.route.js";
import { CourierRoutes } from "../modules/courier/courier.route.js";
import { CourierApplicationRoutes } from "../modules/courierApplication/courierApplication.route.js";
import { PaymentRoutes } from "../modules/payment/payment.route.js";
import { HealthRoutes } from "../modules/health/health.route.js";
import { NotificationRoutes } from "../modules/notification/notification.route.js";
import { HubRoutes } from "../modules/hub/hub.route.js";
import { PricingRoutes } from "../modules/pricing/pricing.route.js";
import { ShipmentRoutes } from "../modules/shipment/shipment.route.js";
import { TrackingRoutes } from "../modules/tracking/tracking.route.js";
import { UserRoutes } from "../modules/user/user.route.js";
import { ZoneRoutes } from "../modules/zone/zone.route.js";

const router = Router();

export interface ModuleRoute {
  path: string;
  route: Router;
}

// Auth routes are mounted separately in app.ts (they must precede express.json()).
/** Mount table (exported so tests can walk every route; see middlewares/readOnly.test.ts). */
export const moduleRoutes: readonly ModuleRoute[] = [
  { path: "/health", route: HealthRoutes },
  { path: "/users", route: UserRoutes },
  { path: "/zones", route: ZoneRoutes },
  { path: "/hubs", route: HubRoutes },
  { path: "/pricing", route: PricingRoutes },
  { path: "/shipments", route: ShipmentRoutes },
  { path: "/couriers", route: CourierRoutes },
  { path: "/courier-applications", route: CourierApplicationRoutes },
  { path: "/admin", route: AdminRoutes },
  { path: "/payments", route: PaymentRoutes },
  { path: "/notifications", route: NotificationRoutes },
  { path: "/tracking", route: TrackingRoutes },
];

for (const { path, route } of moduleRoutes) {
  router.use(path, route);
}

export default router;
