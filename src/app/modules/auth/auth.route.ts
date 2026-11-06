import express, { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
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
// Better Auth's change-password is a password check: failed attempts count toward
// the strict limiter. The limiter only calls next(), so the body stays unread and the
// request continues to the Better Auth allow-list handler in app.ts.
router.post("/change-password", authLimiter);

export const AuthRoutes = router;
