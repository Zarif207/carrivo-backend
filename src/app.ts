import { toNodeHandler } from "better-auth/node";
import cors, { type CorsOptions } from "cors";
import express, { type Application } from "express";
import helmet from "helmet";
import httpStatus from "http-status";
import { env } from "./app/config/env.js";
import { AUTH_BASE_PATH, BETTER_AUTH_ALLOWED_PATHS, auth } from "./app/lib/auth.js";
import { limitBodySize } from "./app/middlewares/limitBodySize.js";
import { globalErrorHandler } from "./app/middlewares/globalErrorHandler.js";
import { globalLimiter } from "./app/middlewares/rateLimiter.js";
import { AuthRoutes } from "./app/modules/auth/auth.route.js";
import { PaymentController } from "./app/modules/payment/payment.controller.js";
import { notFound } from "./app/middlewares/notFound.js";
import router from "./app/routes/index.js";
import { ApiError } from "./app/utils/ApiError.js";
import { sendResponse } from "./app/utils/sendResponse.js";

/** No request body we accept is anywhere near this (uploads will use multipart). */
const BODY_LIMIT = "100kb";
const BODY_LIMIT_BYTES = 100 * 1024;

const app: Application = express();

app.set("trust proxy", 1); // behind Vercel's proxy: correct req.ip for rate limiting
app.disable("x-powered-by");

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser clients (Postman, curl, server-to-server) with no Origin header.
    if (!origin || env.CORS_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new ApiError(httpStatus.FORBIDDEN, `Origin ${origin} is not allowed by CORS`));
  },
  credentials: true,
};

app.use(helmet());
app.use(cors(corsOptions));

// Stripe webhook FIRST: it needs the raw body (signature over exact bytes), so it
// must come before express.json(); and it is exempt from the per-IP limiter because
// Stripe sends from shared IPs. The signature check is what protects it.
app.post("/api/v1/payments/webhook", express.raw({ type: "application/json", limit: "1mb" }), PaymentController.webhook);

app.use(globalLimiter);

// ── Must come BEFORE express.json() ─────────────────────────────────────────
// 1. Our auth wrappers (register/login/logout/refresh-token, change-password limiter). They
//    parse JSON per route, so unmatched /auth/* requests keep an unread body.
// 2. Better Auth, for an ALLOW-LIST of its endpoints only (lib/auth.ts). It reads
//    the body itself, so a Content-Length guard enforces our size limit first.
//    Any other /auth/* path falls through to our 404 envelope.
app.use(AUTH_BASE_PATH, AuthRoutes);
app.all(
  BETTER_AUTH_ALLOWED_PATHS.map((path) => `${AUTH_BASE_PATH}${path}`),
  limitBodySize(BODY_LIMIT_BYTES),
  toNodeHandler(auth),
);

app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

app.get("/", (_req, res) => {
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: "Carrivo API is running",
    data: { version: "v1", docs: "/api/v1/health" },
  });
});

app.use("/api/v1", router);

app.use(notFound);
app.use(globalErrorHandler);

export default app;
