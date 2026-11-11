import { Router, type RequestHandler } from "express";
import { Role } from "../../../generated/prisma/enums.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize, type AuthorizeHandler } from "../../middlewares/authorize.js";
import { applicationLimiter } from "../../middlewares/rateLimiter.js";
import { validateRequest } from "../../middlewares/validateRequest.js";
import { ApiError } from "../../utils/ApiError.js";
import { CourierApplicationController } from "./courierApplication.controller.js";
import { roleRefusal } from "./courierApplication.utils.js";
import { CourierApplicationValidation } from "./courierApplication.validation.js";

/**
 * authorize(CUSTOMER) with clearer refusals, before the body is validated: staff get 403 ("staff
 * accounts can't apply"), couriers 409 ("already a courier"). ADMIN_VIEWER never gets here: the
 * read-only rule in authenticate() refuses its POST first. Carries allowedRoles for readOnly.test.ts.
 */
const applicantOnly: AuthorizeHandler = Object.assign(
  ((req, _res, next) => {
    const refusal = req.user ? roleRefusal(req.user.role) : null;
    next(refusal ? new ApiError(refusal.status, refusal.message) : undefined);
  }) satisfies RequestHandler,
  { allowedRoles: [Role.CUSTOMER] as const },
);

// /courier-applications: the applicant's side. Staff routes live in admin.route.ts.
const router = Router();
router.use(authenticate);

router.post("/", applicationLimiter, applicantOnly, validateRequest(CourierApplicationValidation.apply), CourierApplicationController.apply);
// Couriers keep read access: their approved application stays visible.
router.get("/my", authorize(Role.CUSTOMER, Role.COURIER), CourierApplicationController.getMine);
router.patch(
  "/my/:id/cancel",
  applicationLimiter,
  authorize(Role.CUSTOMER),
  validateRequest(CourierApplicationValidation.byId),
  CourierApplicationController.cancelMine,
);

export const CourierApplicationRoutes = router;
