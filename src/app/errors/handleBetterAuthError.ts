import type { APIError } from "better-auth/api";
import httpStatus from "http-status";
import type { NormalizedError } from "../types/response.types.js";

/** Better Auth error codes we remap to keep status codes consistent across the API. */
const STATUS_OVERRIDES: Record<string, number> = {
  USER_ALREADY_EXISTS: httpStatus.CONFLICT,
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: httpStatus.CONFLICT,
  INVALID_EMAIL_OR_PASSWORD: httpStatus.UNAUTHORIZED,
};

export const handleBetterAuthError = (error: APIError): NormalizedError => {
  const code = typeof error.body?.code === "string" ? error.body.code : undefined;
  const message =
    typeof error.body?.message === "string" && error.body.message.length > 0
      ? error.body.message
      : error.message || "Authentication failed";
  const statusCode =
    (code ? STATUS_OVERRIDES[code] : undefined) ??
    (error.statusCode >= 400 ? error.statusCode : httpStatus.BAD_REQUEST);

  return {
    statusCode,
    message,
    errors: code ? [{ path: "", message: code }] : [],
  };
};
