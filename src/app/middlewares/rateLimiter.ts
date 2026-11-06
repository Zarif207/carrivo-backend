import type { RequestHandler } from "express";
import rateLimit, { type Options } from "express-rate-limit";
import httpStatus from "http-status";
import type { ErrorResponse } from "../types/response.types.js";

const FIFTEEN_MINUTES = 15 * 60 * 1000;

const limitHandler: Options["handler"] = (_req, res, _next, options) => {
  const body: ErrorResponse = {
    success: false,
    message: typeof options.message === "string" ? options.message : "Too many requests",
    errors: [],
  };
  res.status(httpStatus.TOO_MANY_REQUESTS).json(body);
};

/*
 * NOTE: these use express-rate-limit's default in-memory store. On Vercel each
 * warm serverless instance keeps its own counters and loses them on cold start,
 * so limits are approximate (per instance). Phase 5 moves the store to Upstash Redis.
 */

/** Default limiter for every route. */
export const globalLimiter: RequestHandler = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: "Too many requests, please try again later",
  handler: limitHandler,
});

/** Stricter limiter for /auth/login and /auth/register. Only failed attempts count. */
export const authLimiter: RequestHandler = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: "Too many authentication attempts, please try again in 15 minutes",
  handler: limitHandler,
});
