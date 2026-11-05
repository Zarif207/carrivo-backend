import httpStatus from "http-status";
import type { ZodError } from "zod";
import type { NormalizedError } from "../types/response.types.js";

export const handleZodError = (error: ZodError): NormalizedError => ({
  statusCode: httpStatus.BAD_REQUEST,
  message: "Validation failed",
  errors: error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  })),
});
