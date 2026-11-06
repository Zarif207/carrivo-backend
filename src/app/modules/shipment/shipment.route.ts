import { Router } from "express";
import { Role } from "../../../generated/prisma/enums.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { uploadSingleImage } from "../../middlewares/uploadImage.js";
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

// ── Workflow (Phase 4). Role rules per transition live in shipment.constants.ts (TRANSITIONS).
router.post(
  "/:id/pickup",
  authorize(Role.CUSTOMER),
  validateRequest(ShipmentValidation.pickup),
  ShipmentController.schedulePickup,
);
router.post("/:id/assign", authorize(Role.ADMIN), validateRequest(ShipmentValidation.assign), ShipmentController.assign);
router.post(
  "/:id/unassign",
  authorize(Role.ADMIN),
  validateRequest(ShipmentValidation.unassign),
  ShipmentController.unassign,
);
router.patch(
  "/:id/status",
  authorize(Role.COURIER, Role.ADMIN),
  validateRequest(ShipmentValidation.updateStatus),
  ShipmentController.updateStatus,
);

// Proof of delivery: multipart/form-data, one `image` file (JPEG/PNG/WebP, ≤ 4 MB). Assigned courier only.
router.post(
  "/:id/proof",
  authorize(Role.COURIER),
  validateRequest(ShipmentValidation.byId),
  uploadSingleImage("image"),
  ShipmentController.uploadProof,
);

export const ShipmentRoutes = router;
