import httpStatus from "http-status";
import { Prisma } from "../../generated/prisma/client.js";
import type { NormalizedError } from "../types/response.types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Pulls the conflicting field names out of a P2002 error. Prisma puts them in
 * `meta.target` without a driver adapter, or in
 * `meta.driverAdapterError.cause.constraint.fields` with one, so both are checked.
 */
const getUniqueFields = (meta: unknown): string[] => {
  if (!isRecord(meta)) return [];
  const target = meta["target"];
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === "string") return [target];

  const adapterError = meta["driverAdapterError"];
  if (isRecord(adapterError) && isRecord(adapterError["cause"])) {
    const constraint = adapterError["cause"]["constraint"];
    if (isRecord(constraint) && Array.isArray(constraint["fields"])) {
      return constraint["fields"].map(String);
    }
  }
  return [];
};

export const handlePrismaKnownError = (
  error: Prisma.PrismaClientKnownRequestError,
): NormalizedError => {
  switch (error.code) {
    case "P2002": {
      const fields = getUniqueFields(error.meta);
      const label = fields.length > 0 ? fields.join(", ") : "field";
      return {
        statusCode: httpStatus.CONFLICT,
        message: `A record with this ${label} already exists`,
        errors: (fields.length > 0 ? fields : [""]).map((path) => ({
          path,
          message: "Value must be unique",
        })),
      };
    }
    case "P2025":
      return {
        statusCode: httpStatus.NOT_FOUND,
        message: "Resource not found",
        errors: [],
      };
    case "P2003":
      return {
        statusCode: httpStatus.BAD_REQUEST,
        message: "Related resource does not exist",
        errors: [],
      };
    default:
      return {
        statusCode: httpStatus.BAD_REQUEST,
        message: "Database request failed",
        errors: [{ path: "", message: `Prisma error ${error.code}` }],
      };
  }
};

export const handlePrismaValidationError = (): NormalizedError => ({
  statusCode: httpStatus.BAD_REQUEST,
  message: "Invalid data sent to the database",
  errors: [],
});
