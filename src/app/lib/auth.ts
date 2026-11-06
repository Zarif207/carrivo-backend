import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins";
import { env } from "../config/env.js";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../modules/audit/audit.constants.js";
import { prisma } from "./prisma.js";

export const AUTH_BASE_PATH = "/api/v1/auth";

/**
 * Our own endpoint Better Auth redirects to after Google (success AND error). It
 * turns the cookie session into a one-time code for the frontend (auth.service.ts).
 */
export const GOOGLE_COMPLETE_PATH = "/google/complete";
export const GOOGLE_COMPLETE_URL = `${env.BETTER_AUTH_URL}${AUTH_BASE_PATH}${GOOGLE_COMPLETE_PATH}`;

/**
 * The ONLY Better Auth endpoints reachable over HTTP (allow-list, see app.ts).
 * Everything else under /api/v1/auth that our own router does not handle gets our
 * 404 envelope. Deliberately excluded:
 * - /list-sessions (returns the raw token of every active session),
 * - /revoke-session (needs a raw token), /verify-password (password oracle),
 * - /sign-in/social: Google sign-in starts at OUR GET /auth/google, which calls it
 *   server-side with fixed callback URLs (a cross-site POST from the frontend would
 *   make the OAuth state cookie a blocked third-party cookie, and would let callers
 *   pick their own callbackURL/scopes),
 * - /callback/:id for any other provider, /link-social, /error and email endpoints.
 */
export const BETTER_AUTH_ALLOWED_PATHS = [
  "/get-session",
  "/change-password",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/ok",
  // Google redirects the browser here (Authorized redirect URI in Google Cloud Console).
  "/callback/google",
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
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      prompt: "select_account",
      // No mapProfileToUser: Google can only set name/email/image, never role or status
      // (both are input:false and default to CUSTOMER / ACTIVE).
    },
  },
  account: {
    accountLinking: {
      // A Google sign-in whose email already belongs to an account is REFUSED
      // (account_not_linked → "account_exists"), never silently linked. Our
      // email/password signup does not verify email ownership, so implicit linking
      // would let someone who pre-registered a victim's address keep password access
      // to the victim's Google-linked account; and it would let Google into seeded
      // ADMIN/COURIER accounts. Google therefore only ever creates CUSTOMERs or signs
      // into accounts it created.
      disableImplicitLinking: true,
    },
    // We never use Google's tokens, but Better Auth stores them: encrypt at rest.
    encryptOAuthTokens: true,
  },
  // Errors Better Auth cannot attribute to a flow (e.g. missing state) land on our
  // complete endpoint too, which maps them to a fixed set (Better Auth's /error page stays closed).
  onAPIError: { errorURL: GOOGLE_COMPLETE_URL },
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
            if (user) {
              await prisma.auditLog.create({
                data: {
                  actorId: null,
                  actorRole: null,
                  action: AUDIT_ACTIONS.USER_LOGIN_REFUSED,
                  entityType: AUDIT_ENTITIES.USER,
                  entityId: session.userId,
                  after: { reason: user.deletedAt ? "deleted" : "inactive" },
                  ipAddress: session.ipAddress ?? null,
                  userAgent: session.userAgent?.slice(0, 500) ?? null,
                },
                select: { id: true },
              });
            }
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
