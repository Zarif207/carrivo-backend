import type { RequestHandler } from "express";
import { fromNodeHeaders } from "better-auth/node";
import httpStatus from "http-status";
import { isReadOnlyRole } from "../config/roles.js";
import { auth } from "../lib/auth.js";
import type { Role } from "../../generated/prisma/enums.js";
import { ApiError } from "../utils/ApiError.js";
import { catchAsync } from "../utils/catchAsync.js";

/*
 * The read-only rule, keyed on HTTP method + role (never per route):
 * a READ_ONLY_ROLES account (ADMIN_VIEWER) may only use safe methods, plus the session
 * endpoints it needs to stay signed in or leave, plus marking its own notifications read. Called from authenticate() for every
 * protected route, and from blockReadOnlyOnBetterAuth for Better Auth's own endpoints.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Mutations a read-only account may still make: ending or rotating its own session. */
export const READ_ONLY_ALLOWED_MUTATIONS: ReadonlySet<string> = new Set(["POST /api/v1/auth/logout", "POST /api/v1/auth/refresh-token"]);

/**
 * Parameterized exceptions, anchored on both ends. Only the caller's OWN notification read
 * state: marking read is not a business write (the service scopes it to the caller's rows).
 * DELETE /notifications/:id is deliberately absent, so a viewer still gets the 403.
 */
export const READ_ONLY_ALLOWED_PATTERNS: readonly { method: string; path: RegExp }[] = [
  { method: "PATCH", path: /^\/api\/v1\/notifications\/read-all$/ },
  { method: "PATCH", path: /^\/api\/v1\/notifications\/[^/]+\/read$/ },
];

export const READ_ONLY_MESSAGE = "This account is read-only";

const pathOnly = (url: string): string => (url.split("?")[0] ?? "").replace(/\/+$/, "") || "/";

/** True when `role` may not perform `method` on `url` (the full original URL, e.g. req.originalUrl). */
export function violatesReadOnly(role: Role, method: string, url: string): boolean {
  if (!isReadOnlyRole(role)) return false;
  const verb = method.toUpperCase();
  if (SAFE_METHODS.has(verb)) return false;
  const path = pathOnly(url);
  if (READ_ONLY_ALLOWED_MUTATIONS.has(`${verb} ${path}`)) return false;
  return !READ_ONLY_ALLOWED_PATTERNS.some((rule) => rule.method === verb && rule.path.test(path));
}

export const readOnlyError = (): ApiError => new ApiError(httpStatus.FORBIDDEN, READ_ONLY_MESSAGE);

/**
 * Better Auth's allow-listed endpoints (change-password, revoke-sessions, ...) don't go through
 * authenticate(), so mutating requests there resolve the session here first.
 */
export const blockReadOnlyOnBetterAuth: RequestHandler = catchAsync(async (req, _res, next) => {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }
  const result = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  const role = result?.user.role;
  if (typeof role === "string" && violatesReadOnly(role as Role, req.method, req.originalUrl)) throw readOnlyError();
  next();
});
