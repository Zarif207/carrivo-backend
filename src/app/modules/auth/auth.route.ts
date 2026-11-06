import express, { Router } from "express";
import { Role } from "../../../generated/prisma/enums.js";
import { DISABLED_PATHS } from "../../lib/auth.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { notFound } from "../../middlewares/notFound.js";
import { authorize } from "../../middlewares/authorize.js";
import { authLimiter } from "../../middlewares/rateLimiter.js";
import { validateRequest } from "../../middlewares/validateRequest.js";
import { AuthController } from "./auth.controller.js";
import { AuthValidation } from "./auth.validation.js";

/*
 * Mounted at /api/v1/auth BEFORE the Better Auth catch-all. JSON parsing is applied
 * per route (never router-wide), so any path this router does not match reaches
 * Better Auth with its body stream still unread.
 */
const router = Router();
const json = express.json({ limit: "100kb" });

router.post("/register", authLimiter, json, validateRequest(AuthValidation.register), AuthController.register);
router.post("/login", authLimiter, json, validateRequest(AuthValidation.login), AuthController.login);
router.post("/logout", authenticate, AuthController.logout);
router.post("/refresh-token", authenticate, AuthController.refreshToken);
router.get("/admin-check", authenticate, authorize(Role.ADMIN), AuthController.adminCheck);

// Better Auth endpoints we disabled: answer with our 404 envelope instead of its plain-text 404.
router.all(DISABLED_PATHS, notFound);

export const AuthRoutes = router;
