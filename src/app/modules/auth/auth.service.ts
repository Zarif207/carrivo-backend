import { randomUUID } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import httpStatus from "http-status";
import { z } from "zod";
import { Role, UserStatus } from "../../../generated/prisma/enums.js";
import { FRONTEND_PATHS, joinFrontendUrl } from "../../config/frontendRoutes.js";
import { env } from "../../config/env.js";
import { GOOGLE_COMPLETE_URL, auth } from "../../lib/auth.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthSession } from "../../types/auth.types.js";
import { ApiError } from "../../utils/ApiError.js";
import type { RequestMeta } from "../../utils/requestMeta.js";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../audit/audit.constants.js";
import { AuditService } from "../audit/audit.service.js";
import { UserService } from "../user/user.service.js";
import {
  EXCHANGE_CODE_PATTERN,
  EXCHANGE_CODE_TTL_MS,
  exchangeIdentifier,
  mapGoogleError,
  newExchangeCode,
  verifyChallenge,
  type GoogleErrorCode,
} from "./auth.google.utils.js";
import type { AuthResult, AuthTokenResult, GoogleStartResult } from "./auth.types.js";
import type { GoogleCompleteQuery, LoginInput, RegisterInput } from "./auth.validation.js";

/**
 * Signs a raw session token the same way Better Auth signs its session cookie
 * (`<token>.<HMAC-SHA256>`). The bearer plugin verifies this signature before
 * looking the session up, so every token we hand out has the same format.
 */
const signToken = async (rawToken: string): Promise<string> =>
  `${rawToken}.${await makeSignature(rawToken, env.BETTER_AUTH_SECRET)}`;

const getSessionExpiry = async (rawToken: string): Promise<Date> => {
  const session = await prisma.session.findUnique({
    where: { token: rawToken },
    select: { expiresAt: true },
  });
  if (!session) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "Session was not created");
  }
  return session.expiresAt;
};

const buildAuthResult = async (userId: string, rawToken: string): Promise<AuthResult> => {
  const [user, expiresAt, token] = await Promise.all([
    UserService.getSafeUserById(userId),
    getSessionExpiry(rawToken),
    signToken(rawToken),
  ]);
  return { token, expiresAt: expiresAt.toISOString(), user };
};

/** Self-registration always creates a CUSTOMER (role is `input: false` in Better Auth). */
const register = async (payload: RegisterInput, headers: Headers): Promise<AuthResult> => {
  const result = await auth.api.signUpEmail({
    body: {
      name: payload.name,
      email: payload.email,
      password: payload.password,
      ...(payload.phone ? { phone: payload.phone } : {}),
    },
    headers,
  });
  if (!result.token) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "Registration succeeded but no session was created");
  }
  return buildAuthResult(result.user.id, result.token);
};

const login = async (payload: LoginInput, headers: Headers): Promise<AuthResult> => {
  const result = await auth.api.signInEmail({
    body: { email: payload.email, password: payload.password },
    headers,
  });
  return buildAuthResult(result.user.id, result.token);
};

/** Revokes the session behind the Bearer token. */
const logout = async (headers: Headers): Promise<void> => {
  await auth.api.signOut({ headers });
};

/**
 * Session rotation: issue a brand-new session for the user and revoke the old
 * one. Better Auth has no refresh tokens (a session token IS the credential), so
 * "refresh" means swapping the token for a fresh one with a new 7-day expiry.
 * createSession runs the `session.create.before` hook, so deactivated users
 * cannot refresh.
 */
const refreshToken = async (userId: string, current: AuthSession): Promise<AuthTokenResult> => {
  const ctx = await auth.$context;
  const newSession = await ctx.internalAdapter.createSession(userId);
  if (!newSession) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "Could not create a new session");
  }
  await ctx.internalAdapter.deleteSession(current.token);

  return {
    token: await signToken(newSession.token),
    expiresAt: newSession.expiresAt.toISOString(),
  };
};

// ───────── Google sign-in (see the flow in auth.route.ts) ─────────

/**
 * Step 1: asks Better Auth for Google's authorization URL. It also returns the
 * Set-Cookie for the OAuth state (bound to this browser), which the controller
 * forwards. Callback URLs are fixed server-side; the client cannot choose them.
 */
const startGoogle = async (headers: Headers): Promise<GoogleStartResult> => {
  const { headers: responseHeaders, response } = await auth.api.signInSocial({
    body: {
      provider: "google",
      callbackURL: GOOGLE_COMPLETE_URL,
      newUserCallbackURL: `${GOOGLE_COMPLETE_URL}?new=1`,
      errorCallbackURL: GOOGLE_COMPLETE_URL,
      disableRedirect: true,
    },
    headers,
    returnHeaders: true,
  });
  if (!("url" in response) || !response.url) {
    throw new ApiError(httpStatus.BAD_GATEWAY, "Could not start Google sign-in");
  }
  return { url: response.url, setCookies: responseHeaders.getSetCookie() };
};

const googleRedirect = (params: Record<string, string>): string =>
  `${joinFrontendUrl(env.FRONTEND_URL, FRONTEND_PATHS.googleCallback)}?${new URLSearchParams(params).toString()}`;

export const googleErrorRedirect = (code: GoogleErrorCode): string => googleRedirect({ error: code });

const exchangeValueSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  challenge: z.string().min(1),
  isNewUser: z.boolean(),
});

/**
 * Step 3: Better Auth has created the session and set its cookie (API domain only).
 * Swap it for a one-time code: 32 random bytes, 60 s, single use, stored hashed,
 * bound to the PKCE challenge. Returns the frontend URL to redirect to. The
 * controller clears every auth cookie, so the session token never leaves the API.
 */
const completeGoogle = async (headers: Headers, query: GoogleCompleteQuery, challenge: string | null): Promise<string> => {
  if (query.error) return googleErrorRedirect(mapGoogleError(query.error));
  if (!challenge) return googleErrorRedirect("google_failed");

  const result = await auth.api.getSession({ headers });
  if (!result) return googleErrorRedirect("google_failed");
  const { user, session } = result;
  if (user.status !== UserStatus.ACTIVE || user.deletedAt) return googleErrorRedirect("account_deactivated");

  // "new" only comes from Better Auth's newUserCallbackURL; cross-check it against the data.
  let isNewUser = false;
  if (query.new === "1") {
    const accounts = await prisma.account.findMany({ where: { userId: user.id }, select: { providerId: true, createdAt: true } });
    isNewUser =
      accounts.length === 1 &&
      accounts[0]?.providerId === "google" &&
      Date.now() - accounts[0].createdAt.getTime() < 10 * 60_000;
  }

  const code = newExchangeCode();
  await prisma.verification.create({
    data: {
      id: randomUUID(),
      identifier: exchangeIdentifier(code),
      // The session ID, not its token: a database read never yields a credential.
      value: JSON.stringify({ sessionId: session.id, userId: user.id, challenge, isNewUser }),
      expiresAt: new Date(Date.now() + EXCHANGE_CODE_TTL_MS),
    },
    select: { id: true },
  });
  return googleRedirect({ code });
};

const invalidCode = (): ApiError =>
  new ApiError(httpStatus.BAD_REQUEST, "Invalid or expired code, please sign in with Google again", [
    { path: "body.code", message: "Invalid or expired" },
  ]);

/**
 * Step 4: POST { code, codeVerifier } → our normal { token, expiresAt, user }.
 * The row is DELETEd atomically first, so a code works at most once even under
 * concurrent requests, and a wrong verifier also burns it.
 */
const exchangeGoogle = async (code: string, codeVerifier: string, meta: RequestMeta): Promise<AuthResult> => {
  if (!EXCHANGE_CODE_PATTERN.test(code)) throw invalidCode();
  const rows = await prisma.$queryRaw<{ value: string; expiresAt: Date }[]>`
    DELETE FROM "verifications" WHERE "identifier" = ${exchangeIdentifier(code)} RETURNING "value", "expiresAt"`;
  const row = rows[0];
  if (!row || row.expiresAt.getTime() <= Date.now()) throw invalidCode();

  const parsed = exchangeValueSchema.safeParse(JSON.parse(row.value));
  if (!parsed.success || !verifyChallenge(codeVerifier, parsed.data.challenge)) throw invalidCode();
  const { sessionId, userId, isNewUser } = parsed.data;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { token: true, expiresAt: true, userId: true, user: { select: { status: true, deletedAt: true, role: true } } },
  });
  if (!session || session.userId !== userId || session.expiresAt.getTime() <= Date.now()) throw invalidCode();
  if (session.user.status !== UserStatus.ACTIVE || session.user.deletedAt) {
    await prisma.session.delete({ where: { id: sessionId } });
    throw new ApiError(httpStatus.FORBIDDEN, "Account is deactivated");
  }

  await AuditService.log(prisma, {
    actor: { id: userId, role: session.user.role },
    action: isNewUser ? AUDIT_ACTIONS.USER_REGISTERED_GOOGLE : AUDIT_ACTIONS.USER_LOGIN_GOOGLE,
    entityType: AUDIT_ENTITIES.USER,
    entityId: userId,
    after: { provider: "google", ...(isNewUser ? { role: Role.CUSTOMER } : {}) },
    meta,
  });
  return buildAuthResult(userId, session.token);
};

export const AuthService = { register, login, logout, refreshToken, startGoogle, completeGoogle, exchangeGoogle };
