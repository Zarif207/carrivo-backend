import { Router } from "express";
import { CourierRoutes } from "../modules/courier/courier.route.js";
import { HealthRoutes } from "../modules/health/health.route.js";
import { HubRoutes } from "../modules/hub/hub.route.js";
import { PricingRoutes } from "../modules/pricing/pricing.route.js";
import { ShipmentRoutes } from "../modules/shipment/shipment.route.js";
import { TrackingRoutes } from "../modules/tracking/tracking.route.js";
import { UserRoutes } from "../modules/user/user.route.js";
import { ZoneRoutes } from "../modules/zone/zone.route.js";

const router = Router();

interface ModuleRoute {
  path: string;
  route: Router;
}

// Auth routes are mounted separately in app.ts (they must precede express.json()).
const moduleRoutes: ModuleRoute[] = [
  { path: "/health", route: HealthRoutes },
  { path: "/users", route: UserRoutes },
  { path: "/zones", route: ZoneRoutes },
  { path: "/hubs", route: HubRoutes },
  { path: "/pricing", route: PricingRoutes },
  { path: "/shipments", route: ShipmentRoutes },
  { path: "/couriers", route: CourierRoutes },
  { path: "/tracking", route: TrackingRoutes },
];

for (const { path, route } of moduleRoutes) {
  router.use(path, route);
}

export default router;
