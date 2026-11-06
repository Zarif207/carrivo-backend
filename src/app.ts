import { toNodeHandler } from "better-auth/node";
import cors, { type CorsOptions } from "cors";
import express, { type Application } from "express";
import helmet from "helmet";
import httpStatus from "http-status";
import { env } from "./app/config/env.js";
import { AUTH_BASE_PATH, auth } from "./app/lib/auth.js";
import { globalErrorHandler } from "./app/middlewares/globalErrorHandler.js";
import { globalLimiter } from "./app/middlewares/rateLimiter.js";
import { AuthRoutes } from "./app/modules/auth/auth.route.js";
import { notFound } from "./app/middlewares/notFound.js";
import router from "./app/routes/index.js";
import { ApiError } from "./app/utils/ApiError.js";
import { sendResponse } from "./app/utils/sendResponse.js";

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
app.use(globalLimiter);

// ── Must come BEFORE express.json() ─────────────────────────────────────────
// 1. Our auth wrappers (register/login/logout/refresh-token/admin-check). They
//    parse JSON per route, so unmatched /auth/* requests keep an unread body.
// 2. Better Auth catch-all for its remaining endpoints (get-session,
//    change-password, sessions, ...). Express 5 needs a named wildcard.
// 3. Phase 6: the Stripe webhook raw-body route goes here too.
app.use(AUTH_BASE_PATH, AuthRoutes);
app.all(`${AUTH_BASE_PATH}/*splat`, toNodeHandler(auth));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

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
