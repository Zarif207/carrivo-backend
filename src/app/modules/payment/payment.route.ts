import { Router } from "express";
import { Role } from "../../../generated/prisma/enums.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { STAFF_ROLES } from "../../config/roles.js";
import { authorize } from "../../middlewares/authorize.js";
import { validateRequest } from "../../middlewares/validateRequest.js";
import { PaymentController } from "./payment.controller.js";
import { PaymentValidation } from "./payment.validation.js";

/** /api/v1/payments (the webhook is mounted separately in app.ts, before express.json). */
const router = Router();
router.use(authenticate);

router.post("/initiate", authorize(Role.CUSTOMER), validateRequest(PaymentValidation.initiate), PaymentController.initiate);
// Not for ADMIN_VIEWER: verify can write (it reconciles a paid session).
router.get("/verify", authorize(Role.CUSTOMER, Role.ADMIN), validateRequest(PaymentValidation.verify), PaymentController.verify);
router.get("/my", authorize(Role.CUSTOMER), validateRequest(PaymentValidation.listMine), PaymentController.listMine);
router.get("/:id", authorize(Role.CUSTOMER, ...STAFF_ROLES), validateRequest(PaymentValidation.byId), PaymentController.getById);

export const PaymentRoutes = router;
