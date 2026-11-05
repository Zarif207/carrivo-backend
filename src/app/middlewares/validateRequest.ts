import type { RequestHandler } from "express";
import { z } from "zod";
import { catchAsync } from "../utils/catchAsync.js";

/**
 * Schema shape for validateRequest. Every key is optional; each one present is
 * validated against the matching part of the request.
 */
export type RequestSchema = z.ZodObject<{
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}>;

export interface ValidatedRequest {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

/**
 * Validates body/query/params. Parsed values replace `req.body` and are stored
 * in `res.locals.validated`. Express 5 makes `req.query` a read-only getter, so
 * controllers read parsed query values from `res.locals.validated.query`.
 */
export const validateRequest = (schema: RequestSchema): RequestHandler =>
  catchAsync(async (req, res, next) => {
    const parsed = (await schema.parseAsync({
      body: req.body as unknown,
      query: req.query,
      params: req.params,
    })) as ValidatedRequest;

    if (parsed.body !== undefined) {
      req.body = parsed.body;
    }
    res.locals["validated"] = parsed;
    next();
  });
