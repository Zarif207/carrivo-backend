import { Router } from "express";
import { Role } from "../../../generated/prisma/enums.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { STAFF_ROLES } from "../../config/roles.js";
import { authorize } from "../../middlewares/authorize.js";
import { validateRequest } from "../../middlewares/validateRequest.js";
import { CourierController } from "./courier.controller.js";
import { CourierValidation } from "./courier.validation.js";

const router = Router();
router.use(authenticate);

const courier = authorize(Role.COURIER);

router.get("/me/tasks", courier, validateRequest(CourierValidation.tasks), CourierController.myTasks);
router.get("/me/earnings", courier, validateRequest(CourierValidation.earnings), CourierController.myEarnings);
router.patch(
  "/me/availability",
  courier,
  validateRequest(CourierValidation.availability),
  CourierController.setAvailability,
);

// Admin: eligible couriers for the assignment screen.
router.get("/", authorize(...STAFF_ROLES), validateRequest(CourierValidation.list), CourierController.list);

export const CourierRoutes = router;
