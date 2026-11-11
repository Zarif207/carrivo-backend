import { Router } from "express";
import { Role } from "../../../generated/prisma/enums.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { STAFF_ROLES } from "../../config/roles.js";
import { authorize } from "../../middlewares/authorize.js";
import { validateRequest } from "../../middlewares/validateRequest.js";
import { AuditController } from "../audit/audit.controller.js";
import { AuditValidation } from "../audit/audit.validation.js";
import { CourierApplicationController } from "../courierApplication/courierApplication.controller.js";
import { CourierApplicationValidation } from "../courierApplication/courierApplication.validation.js";
import { PaymentController } from "../payment/payment.controller.js";
import { PaymentValidation } from "../payment/payment.validation.js";
import { AdminController } from "./admin.controller.js";
import { AdminValidation } from "./admin.validation.js";

const router = Router();

// /admin: staff only (ADMIN, plus ADMIN_VIEWER for reads).
// Everyone here is staff; reads are open to ADMIN_VIEWER, every write needs ADMIN (and the
// read-only rule in authenticate() rejects ADMIN_VIEWER mutations anyway).
router.use(authenticate, authorize(...STAFF_ROLES));
const adminOnly = authorize(Role.ADMIN);

router.get("/users", validateRequest(AdminValidation.listUsers), AdminController.listUsers);
router.post("/users", adminOnly, validateRequest(AdminValidation.createUser), AdminController.createUser);
router.patch("/users/:id/role", adminOnly, validateRequest(AdminValidation.changeRole), AdminController.changeRole);
router.patch("/users/:id/status", adminOnly, validateRequest(AdminValidation.changeStatus), AdminController.changeStatus);
router.get("/dashboard-stats", AdminController.dashboardStats);
router.get("/audit-logs", validateRequest(AuditValidation.list), AuditController.list);
router.get("/payments", validateRequest(PaymentValidation.adminList), PaymentController.adminList);
router.post("/payments/:id/refund", adminOnly, validateRequest(PaymentValidation.byId), PaymentController.retryRefund);
// Courier applications: staff read the queue; only ADMIN decides (ADMIN_VIEWER → read-only 403).
router.get("/courier-applications", validateRequest(CourierApplicationValidation.adminList), CourierApplicationController.adminList);
router.get("/courier-applications/:id", validateRequest(CourierApplicationValidation.byId), CourierApplicationController.adminGet);
router.patch(
  "/courier-applications/:id/approve",
  adminOnly,
  validateRequest(CourierApplicationValidation.approve),
  CourierApplicationController.approve,
);
router.patch(
  "/courier-applications/:id/reject",
  adminOnly,
  validateRequest(CourierApplicationValidation.reject),
  CourierApplicationController.reject,
);

export const AdminRoutes = router;
