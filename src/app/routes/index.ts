import { Router } from "express";
import { HealthRoutes } from "../modules/health/health.route.js";
import { UserRoutes } from "../modules/user/user.route.js";

const router = Router();

interface ModuleRoute {
  path: string;
  route: Router;
}

// Auth routes are mounted separately in app.ts (they must precede express.json()).
const moduleRoutes: ModuleRoute[] = [
  { path: "/health", route: HealthRoutes },
  { path: "/users", route: UserRoutes },
];

for (const { path, route } of moduleRoutes) {
  router.use(path, route);
}

export default router;
