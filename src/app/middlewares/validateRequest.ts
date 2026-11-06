import type { RequestHandler, Response } from "express";
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
/**
 * Parsed query values stored by validateRequest. `T` must be the z.infer output of
 * the route's query schema; validateRequest guarantees the shape at runtime.
 */
export const getValidatedQuery = <T>(res: Response): T => {
  const validated = res.locals["validated"] as ValidatedRequest | undefined;
  return validated?.query as T;
};

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
