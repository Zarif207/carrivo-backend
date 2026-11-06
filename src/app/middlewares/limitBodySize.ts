import type { RequestHandler } from "express";
import httpStatus from "http-status";
import type { ErrorResponse } from "../types/response.types.js";

/**
 * Size guard for routes whose body is read by someone else (Better Auth).
 * Rejects a declared Content-Length over the limit with 413, and a body with no
 * Content-Length (chunked) with 411, without reading the stream.
 */
export const limitBodySize =
  (maxBytes: number): RequestHandler =>
  (req, res, next) => {
    const send = (status: number, message: string): void => {
      const body: ErrorResponse = { success: false, message, errors: [] };
      res.status(status).json(body);
    };
    const hasBody = req.headers["transfer-encoding"] !== undefined || req.headers["content-length"] !== undefined;
    if (!hasBody) return next();
    const length = Number(req.headers["content-length"]);
    if (!Number.isFinite(length)) return send(httpStatus.LENGTH_REQUIRED, "Content-Length is required");
    if (length > maxBytes) return send(httpStatus.REQUEST_ENTITY_TOO_LARGE, `Request body must be at most ${maxBytes} bytes`);
    next();
  };
