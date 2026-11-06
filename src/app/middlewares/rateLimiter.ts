import type { RequestHandler } from "express";
import rateLimit, { type Options } from "express-rate-limit";
import httpStatus from "http-status";
import type { Redis } from "@upstash/redis";
import { redis, redisKey, warnRedis } from "../lib/redis.js";
import type { ErrorResponse } from "../types/response.types.js";
import { RedisRateLimitStore, type RateLimitBackend } from "../utils/redisRateLimitStore.js";

const FIFTEEN_MINUTES = 15 * 60 * 1000;

const limitHandler: Options["handler"] = (_req, res, _next, options) => {
  const body: ErrorResponse = {
    success: false,
    message: typeof options.message === "string" ? options.message : "Too many requests",
    errors: [],
  };
  res.status(httpStatus.TOO_MANY_REQUESTS).json(body);
};

/** INCR + PEXPIRE NX + PTTL in one Upstash pipeline (one REST round trip per request). */
const upstashBackend = (client: Redis): RateLimitBackend => ({
  incrementWithTtl: async (key, windowMs) => {
    const [totalHits, , ttlMs] = await client.pipeline().incr(key).pexpire(key, windowMs, "NX").pttl(key).exec<
      [number, number, number]
    >();
    return { totalHits, ttlMs };
  },
  decrement: async (key) => {
    await client.decr(key);
  },
  reset: async (key) => {
    await client.del(key);
  },
});

/*
 * Counters live in Upstash Redis so every serverless instance shares them. If
 * Redis is not configured or a call fails, the store counts in memory for that
 * request instead (per-instance limits), so the API keeps working.
 */
const store = (name: string): RedisRateLimitStore =>
  new RedisRateLimitStore({
    backend: redis ? upstashBackend(redis) : null,
    prefix: redisKey(`rl:${name}:`),
    onError: warnRedis,
  });

/** Default limiter for every route. */
export const globalLimiter: RequestHandler = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: "Too many requests, please try again later",
  handler: limitHandler,
  store: store("global"),
});

/**
 * Stricter limiter for /auth/login, /auth/register and /auth/change-password.
 * Only failed attempts count (successful ones are decremented).
 */
export const authLimiter: RequestHandler = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: 20,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: "Too many authentication attempts, please try again in 15 minutes",
  handler: limitHandler,
  store: store("auth"),
});
