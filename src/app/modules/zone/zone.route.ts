import { Router } from "express";
import { Role } from "../../../generated/prisma/enums.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { validateRequest } from "../../middlewares/validateRequest.js";
import { ZoneController } from "./zone.controller.js";
import { ZoneValidation } from "./zone.validation.js";

const router = Router();
const admin = [authenticate, authorize(Role.ADMIN)];

router.get("/", validateRequest(ZoneValidation.list), ZoneController.list);
router.get("/:id", validateRequest(ZoneValidation.byId), ZoneController.getById);
router.post("/", ...admin, validateRequest(ZoneValidation.create), ZoneController.create);
router.patch("/:id", ...admin, validateRequest(ZoneValidation.update), ZoneController.update);
router.delete("/:id", ...admin, validateRequest(ZoneValidation.byId), ZoneController.remove);

export const ZoneRoutes = router;
