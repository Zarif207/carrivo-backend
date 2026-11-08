import type { RequestHandler } from "express";
import httpStatus from "http-status";
import type { Role } from "../../generated/prisma/enums.js";
import { ApiError } from "../utils/ApiError.js";

/** A route guard that remembers its roles, so tests can walk the route table (readOnly.test.ts). */
export type AuthorizeHandler = RequestHandler & { allowedRoles: readonly Role[] };

/** Allows the request only if `req.user.role` is one of `roles`. Use after `authenticate`. */
export const authorize = (...roles: Role[]): AuthorizeHandler => {
  const handler: RequestHandler = (req, _res, next) => {
    if (!req.user) {
      next(new ApiError(httpStatus.UNAUTHORIZED, "Not authenticated"));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new ApiError(httpStatus.FORBIDDEN, "You do not have permission to perform this action"));
      return;
    }
    next();
  };
  return Object.assign(handler, { allowedRoles: roles });
};
