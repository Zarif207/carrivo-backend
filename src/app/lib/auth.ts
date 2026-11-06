import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins";
import { env } from "../config/env.js";
import { prisma } from "./prisma.js";

export const AUTH_BASE_PATH = "/api/v1/auth";

/**
 * The ONLY Better Auth endpoints reachable over HTTP (allow-list, see app.ts).
 * Everything else under /api/v1/auth that our own router does not handle gets our
 * 404 envelope. Deliberately excluded:
 * - /list-sessions (returns the raw token of every active session),
 * - /revoke-session (needs a raw token), /verify-password (password oracle),
 * - social/account/email endpoints until they are configured (Phase 7).
 */
export const BETTER_AUTH_ALLOWED_PATHS = [
  "/get-session",
  "/change-password",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/ok",
] as const;

/**
 * Better Auth endpoints that our own wrappers replace (or that could bypass our
 * whitelists). Disabled for HTTP only; server-side `auth.api.*` calls still work.
 */
export const DISABLED_PATHS = [
  "/sign-up/email",
  "/sign-in/email",
  "/sign-out",
  "/refresh-token",
  "/update-user",
  "/change-email",
  "/delete-user",
];

export const auth = betterAuth({
  appName: "Carrivo",
  baseURL: env.BETTER_AUTH_URL,
  basePath: AUTH_BASE_PATH,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: env.CORS_ORIGINS,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    autoSignIn: true,
  },
  user: {
    additionalFields: {
      role: {
        type: ["CUSTOMER", "COURIER", "ADMIN"],
        required: false,
        defaultValue: "CUSTOMER",
        input: false,
      },
      status: {
        type: ["ACTIVE", "INACTIVE"],
        required: false,
        defaultValue: "ACTIVE",
        input: false,
      },
      deletedAt: {
        type: "date",
        required: false,
        input: false,
      },
      phone: { type: "string", required: false },
      address: { type: "string", required: false },
    },
  },
  databaseHooks: {
    session: {
      create: {
        // Runs for every new session (login, register auto sign-in, refresh rotation).
        before: async (session) => {
          const user = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { status: true, deletedAt: true },
          });
          if (!user || user.status !== "ACTIVE" || user.deletedAt) {
            throw new APIError("FORBIDDEN", {
              message: "Account is deactivated",
              code: "ACCOUNT_DEACTIVATED",
            });
          }
        },
      },
    },
  },
  disabledPaths: DISABLED_PATHS,
  // express-rate-limit handles rate limiting (see middlewares/rateLimiter.ts).
  rateLimit: { enabled: false },
  advanced: {
    // UUIDs generated in the app: the auth tables have no DB-side id default.
    database: { generateId: () => randomUUID() },
  },
  plugins: [bearer()],
});

export type Auth = typeof auth;
