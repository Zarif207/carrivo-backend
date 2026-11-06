import type { Request } from "express";
import { fromNodeHeaders } from "better-auth/node";
import httpStatus from "http-status";
import { Role, UserStatus } from "../../generated/prisma/enums.js";
import { auth } from "../lib/auth.js";
import type { AuthSession, AuthUser } from "../types/auth.types.js";
import { ApiError } from "../utils/ApiError.js";
import { catchAsync } from "../utils/catchAsync.js";

const BEARER_PREFIX = "bearer ";

const isRole = (value: unknown): value is Role =>
  typeof value === "string" && (Object.values(Role) as string[]).includes(value);

const unauthorized = (message: string): ApiError =>
  new ApiError(httpStatus.UNAUTHORIZED, message);

/**
 * Resolves the session from `Authorization: Bearer <token>` (the bearer plugin
 * turns it into the session cookie internally) and attaches `req.user`.
 */
export const authenticate = catchAsync(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith(BEARER_PREFIX) || !header.slice(7).trim()) {
    throw unauthorized("Authentication token is missing");
  }

  const result = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!result) {
    throw unauthorized("Invalid or expired authentication token");
  }

  const { user, session } = result;
  if (user.status !== UserStatus.ACTIVE || user.deletedAt) {
    throw unauthorized("Account is deactivated");
  }
  if (!isRole(user.role)) {
    throw unauthorized("Invalid account role");
  }

  req.user = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: UserStatus.ACTIVE,
  };
  req.authSession = { id: session.id, token: session.token, expiresAt: session.expiresAt };
  next();
});

/** Returns the authenticated user, or throws 401 if `authenticate` did not run. */
export const getAuthUser = (req: Request): AuthUser => {
  if (!req.user) throw unauthorized("Not authenticated");
  return req.user;
};

/** Returns the current session, or throws 401 if `authenticate` did not run. */
export const getAuthSession = (req: Request): AuthSession => {
  if (!req.authSession) throw unauthorized("Not authenticated");
  return req.authSession;
};
