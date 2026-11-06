import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { validateRequest } from "../../middlewares/validateRequest.js";
import { UserController } from "./user.controller.js";
import { UserValidation } from "./user.validation.js";

const router = Router();

router.get("/me", authenticate, UserController.getMe);
router.patch("/me", authenticate, validateRequest(UserValidation.updateMe), UserController.updateMe);

export const UserRoutes = router;
