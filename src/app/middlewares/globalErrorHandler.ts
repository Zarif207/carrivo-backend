import { isAPIError } from "better-auth/api";
import type { ErrorRequestHandler } from "express";
import httpStatus from "http-status";
import { ZodError } from "zod";
import { exposeErrorDetails } from "../config/env.js";
import { handleBetterAuthError } from "../errors/handleBetterAuthError.js";
import { handlePrismaKnownError, handlePrismaValidationError } from "../errors/handlePrismaError.js";
import { handleZodError } from "../errors/handleZodError.js";
import { Prisma } from "../../generated/prisma/client.js";
import type { ErrorResponse, NormalizedError } from "../types/response.types.js";
import { ApiError } from "../utils/ApiError.js";

/** body-parser errors (malformed JSON, payload too large) carry `type` and `status`. */
interface BodyParserError extends Error {
  type: string;
  status: number;
}

const isBodyParserError = (error: unknown): error is BodyParserError =>
  error instanceof Error &&
  typeof (error as Partial<BodyParserError>).type === "string" &&
  typeof (error as Partial<BodyParserError>).status === "number";

const normalizeError = (error: unknown): NormalizedError => {
  if (error instanceof ZodError) return handleZodError(error);
  if (error instanceof ApiError) {
    return { statusCode: error.statusCode, message: error.message, errors: error.errors };
  }
  if (isAPIError(error)) return handleBetterAuthError(error);
  if (error instanceof Prisma.PrismaClientKnownRequestError) return handlePrismaKnownError(error);
  if (error instanceof Prisma.PrismaClientValidationError) return handlePrismaValidationError();
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return {
      statusCode: httpStatus.SERVICE_UNAVAILABLE,
      message: "Database is unavailable",
      errors: [],
    };
  }
  if (isBodyParserError(error)) {
    return {
      statusCode: error.status,
      message: error.type === "entity.parse.failed" ? "Malformed JSON in request body" : error.message,
      errors: [],
    };
  }
  return {
    statusCode: httpStatus.INTERNAL_SERVER_ERROR,
    message: "Something went wrong",
    errors: [],
  };
};

export const globalErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const { statusCode, message, errors } = normalizeError(error);

  if (statusCode >= 500) {
    console.error(error);
  }

  const body: ErrorResponse = {
    success: false,
    message,
    errors,
    ...(exposeErrorDetails && error instanceof Error && error.stack ? { stack: error.stack } : {}),
  };

  res.status(statusCode).json(body);
};
