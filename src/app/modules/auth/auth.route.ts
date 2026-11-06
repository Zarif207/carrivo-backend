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

/*
 * Google sign-in (token handoff for a Bearer API with a separate frontend):
 * 1. GET  /google?challenge=S256(verifier)  browser navigation → 302 to Google
 * 2.      /callback/google                  Better Auth (allow-listed in lib/auth.ts)
 * 3. GET  /google/complete                  → 302 FRONTEND_URL/auth/google/callback?code=… (or ?error=…)
 * 4. POST /google/exchange {code, codeVerifier} → { token, expiresAt, user }
 * No token is ever put in a URL or a redirect; the one-time code is useless without the verifier.
 */
router.get("/google", authLimiter, validateRequest(AuthValidation.googleStart), AuthController.googleStart);
router.get("/google/complete", validateRequest(AuthValidation.googleComplete), AuthController.googleComplete);
router.post("/google/exchange", authLimiter, json, validateRequest(AuthValidation.googleExchange), AuthController.googleExchange);

export const AuthRoutes = router;
