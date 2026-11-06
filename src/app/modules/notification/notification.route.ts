import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { validateRequest } from "../../middlewares/validateRequest.js";
import { NotificationController } from "./notification.controller.js";
import { NotificationValidation } from "./notification.validation.js";

/** /api/v1/notifications: every role, always scoped to the caller's own notifications. */
const router = Router();
router.use(authenticate);

router.get("/my", validateRequest(NotificationValidation.listMine), NotificationController.listMine);
// Registered before "/:id/read" so "read-all" is never parsed as an id.
router.patch("/read-all", NotificationController.markAllRead);
router.patch("/:id/read", validateRequest(NotificationValidation.byId), NotificationController.markRead);

export const NotificationRoutes = router;
