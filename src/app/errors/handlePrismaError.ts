import httpStatus from "http-status";
import { Prisma } from "../../generated/prisma/client.js";
import type { NormalizedError } from "../types/response.types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Pulls the conflicting field names out of a P2002 error. The shape depends on
 * where the query ran, so all known shapes are checked:
 * - `meta.target` (no driver adapter)
 * - `meta.driverAdapterError.cause.constraint.fields` (pg adapter, plain query)
 * - `meta.driverAdapterError.cause.constraint.index`, e.g. "shipments_trackingId_key"
 *   (pg adapter inside an interactive transaction). The field is read from Prisma's
 *   `<table>_<field>_key` index naming, using `cause.table` when present.
 */
export const getUniqueFields = (meta: unknown): string[] => {
  if (!isRecord(meta)) return [];
  const target = meta["target"];
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === "string") return [target];

  const adapterError = meta["driverAdapterError"];
  if (isRecord(adapterError) && isRecord(adapterError["cause"])) {
    const cause = adapterError["cause"];
    const constraint = cause["constraint"];
    if (isRecord(constraint) && Array.isArray(constraint["fields"])) {
      return constraint["fields"].map(String);
    }
    if (isRecord(constraint) && typeof constraint["index"] === "string") {
      const table = typeof cause["table"] === "string" ? cause["table"] : null;
      let name = constraint["index"].replace(/_key$/, "");
      if (table && name.startsWith(`${table}_`)) name = name.slice(table.length + 1);
      return name ? [name] : [];
    }
  }
  return [];
};

/** True only for a P2002 whose conflicting fields include `field`. */
export const isUniqueViolationOn = (error: unknown, field: string): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002" &&
  getUniqueFields(error.meta).includes(field);

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
