import { Router } from "express";
import { Role } from "../../../generated/prisma/enums.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { STAFF_ROLES } from "../../config/roles.js";
import { authorize } from "../../middlewares/authorize.js";
import { validateRequest } from "../../middlewares/validateRequest.js";
import { PricingController } from "./pricing.controller.js";
import { PricingValidation } from "./pricing.validation.js";

const router = Router();
const admin = [authenticate, authorize(Role.ADMIN)];
// Reads: ADMIN and the read-only ADMIN_VIEWER (config/roles.ts).
const staff = [authenticate, authorize(...STAFF_ROLES)];

// Public: lets the frontend show a price before sign-up. Uses the same quote as shipment create.
router.post("/estimate", validateRequest(PricingValidation.estimate), PricingController.estimate);

router.get("/", ...staff, validateRequest(PricingValidation.list), PricingController.list);
router.get("/:id", ...staff, validateRequest(PricingValidation.byId), PricingController.getById);
router.post("/", ...admin, validateRequest(PricingValidation.create), PricingController.create);
router.patch("/:id", ...admin, validateRequest(PricingValidation.update), PricingController.update);
router.delete("/:id", ...admin, validateRequest(PricingValidation.byId), PricingController.remove);

export const PricingRoutes = router;
