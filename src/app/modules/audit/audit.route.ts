import { Router } from "express";
import { validateRequest } from "../../middlewares/validateRequest.js";
import { AuditController } from "./audit.controller.js";
import { AuditValidation } from "./audit.validation.js";

/** Mounted at /admin/audit-logs by the admin router (authenticate + ADMIN already applied). */
const router = Router();

router.get("/", validateRequest(AuditValidation.list), AuditController.list);

export const AuditRoutes = router;
