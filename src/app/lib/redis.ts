import { Redis } from "@upstash/redis";
import { env } from "../config/env.js";

/**
 * Upstash Redis over REST (works on serverless). Optional and FAIL-OPEN:
 * - not configured → `redis` is null and callers skip Redis entirely;
 * - slow or down   → each call times out after REDIS_TIMEOUT_MS, the caller
 *   falls back (DB for the cache, in-memory store for rate limits) and a
 *   warning is logged at most once per minute.
 */
export const REDIS_TIMEOUT_MS = 500;

export const redis: Redis | null =
  env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: env.UPSTASH_REDIS_REST_URL,
        token: env.UPSTASH_REDIS_REST_TOKEN,
        // No retries with backoff: a cache miss is cheaper than a slow request.
        retry: false,
        // A fresh timeout signal per request.
        signal: () => AbortSignal.timeout(REDIS_TIMEOUT_MS),
        automaticDeserialization: false,
        enableAutoPipelining: false,
      })
    : null;

/** Every key we write starts with this (e.g. "carrivo:v1:"). Tests use "carrivo:test:". */
export const redisKey = (key: string): string => `${env.REDIS_KEY_PREFIX}${key}`;

const WARN_INTERVAL_MS = 60_000;
let lastWarnAt = 0;

/** Logs a Redis failure without ever logging values, tokens or the URL. */
export const warnRedis = (operation: string, error: unknown): void => {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
  console.warn(`[redis] ${operation} failed, continuing without Redis (${reason})`);
};

if (!redis) {
  console.warn("[redis] UPSTASH_REDIS_REST_URL/TOKEN not set: caching disabled, rate limits are per instance.");
}
