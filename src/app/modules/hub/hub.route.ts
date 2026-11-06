import { Router } from "express";
import { Role } from "../../../generated/prisma/enums.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { validateRequest } from "../../middlewares/validateRequest.js";
import { HubController } from "./hub.controller.js";
import { HubValidation } from "./hub.validation.js";

const router = Router();
const admin = [authenticate, authorize(Role.ADMIN)];

router.get("/", validateRequest(HubValidation.list), HubController.list);
router.get("/:id", validateRequest(HubValidation.byId), HubController.getById);
router.post("/", ...admin, validateRequest(HubValidation.create), HubController.create);
router.patch("/:id", ...admin, validateRequest(HubValidation.update), HubController.update);
router.delete("/:id", ...admin, validateRequest(HubValidation.byId), HubController.remove);

export const HubRoutes = router;
