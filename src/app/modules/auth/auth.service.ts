import { makeSignature } from "better-auth/crypto";
import httpStatus from "http-status";
import { env } from "../../config/env.js";
import { auth } from "../../lib/auth.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthSession } from "../../types/auth.types.js";
import { ApiError } from "../../utils/ApiError.js";
import { UserService } from "../user/user.service.js";
import type { AuthResult, AuthTokenResult } from "./auth.types.js";
import type { LoginInput, RegisterInput } from "./auth.validation.js";

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

export const AuthService = { register, login, logout, refreshToken };
