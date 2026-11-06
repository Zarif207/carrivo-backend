import { Router } from "express";
import { Role } from "../../../generated/prisma/enums.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { validateRequest } from "../../middlewares/validateRequest.js";
import { AuditRoutes } from "../audit/audit.route.js";
import { AdminController } from "./admin.controller.js";
import { AdminValidation } from "./admin.validation.js";

const router = Router();

// Everything under /admin is ADMIN only.
router.use(authenticate, authorize(Role.ADMIN));

router.get("/users", validateRequest(AdminValidation.listUsers), AdminController.listUsers);
router.post("/users", validateRequest(AdminValidation.createUser), AdminController.createUser);
router.patch("/users/:id/role", validateRequest(AdminValidation.changeRole), AdminController.changeRole);
router.patch("/users/:id/status", validateRequest(AdminValidation.changeStatus), AdminController.changeStatus);
router.get("/dashboard-stats", AdminController.dashboardStats);
router.use("/audit-logs", AuditRoutes);

export const AdminRoutes = router;
