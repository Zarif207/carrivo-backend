import { Router } from "express";
import { Role } from "../../../generated/prisma/enums.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { validateRequest } from "../../middlewares/validateRequest.js";
import { ShipmentController } from "./shipment.controller.js";
import { ShipmentValidation } from "./shipment.validation.js";

const router = Router();

// Every shipment route needs a session; scoping/ownership is enforced in the service.
router.use(authenticate);

router.post("/", authorize(Role.CUSTOMER), validateRequest(ShipmentValidation.create), ShipmentController.create);
router.get("/", validateRequest(ShipmentValidation.list), ShipmentController.list);
router.get("/:id", validateRequest(ShipmentValidation.byId), ShipmentController.getById);
router.patch("/:id", authorize(Role.CUSTOMER), validateRequest(ShipmentValidation.update), ShipmentController.update);
router.post(
  "/:id/cancel",
  authorize(Role.CUSTOMER, Role.ADMIN),
  validateRequest(ShipmentValidation.cancel),
  ShipmentController.cancel,
);
router.delete("/:id", authorize(Role.ADMIN), validateRequest(ShipmentValidation.byId), ShipmentController.remove);

export const ShipmentRoutes = router;
