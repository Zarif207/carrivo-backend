import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { validateRequest } from "../../middlewares/validateRequest.js";
import { NotificationController } from "./notification.controller.js";
import { NotificationValidation } from "./notification.validation.js";

/**
 * /api/v1/notifications: every role, always scoped to the caller's own notifications.
 * ADMIN_VIEWER may use the two PATCH read routes (read state only, see READ_ONLY_ALLOWED_PATTERNS);
 * DELETE stays refused for viewers by the central read-only rule.
 */
const router = Router();
router.use(authenticate);

router.get("/my", validateRequest(NotificationValidation.listMine), NotificationController.listMine);
router.get("/unread-count", NotificationController.unreadCount);
// Registered before "/:id/read" so "read-all" is never parsed as an id.
router.patch("/read-all", NotificationController.markAllRead);
router.patch("/:id/read", validateRequest(NotificationValidation.byId), NotificationController.markRead);
router.delete("/:id", validateRequest(NotificationValidation.byId), NotificationController.remove);

export const NotificationRoutes = router;
