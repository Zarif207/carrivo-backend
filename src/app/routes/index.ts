import { Router } from "express";
import { HealthRoutes } from "../modules/health/health.route.js";

const router = Router();

interface ModuleRoute {
  path: string;
  route: Router;
}

const moduleRoutes: ModuleRoute[] = [{ path: "/health", route: HealthRoutes }];

for (const { path, route } of moduleRoutes) {
  router.use(path, route);
}

export default router;
