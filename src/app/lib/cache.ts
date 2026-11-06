import { env } from "../config/env.js";
import { createCache, type CacheStore } from "../utils/cache.js";
import type { Redis } from "@upstash/redis";
import { redis, warnRedis } from "./redis.js";

/** Upstash implementation of the cache's store interface. */
const upstashStore = (client: Redis): CacheStore => ({
  get: (key) => client.get<string>(key),
  set: async (key, value, ttlSeconds) => {
    await client.set(key, value, { ex: ttlSeconds });
  },
  hget: (key, field) => client.hget<string>(key, field),
  hsetWithTtl: async (key, field, value, ttlSeconds) => {
    // One round trip. NX: only the first fill sets the expiry, so no entry
    // in the hash can outlive ttlSeconds no matter how often fields are added.
    await client.pipeline().hset(key, { [field]: value }).expire(key, ttlSeconds, "NX").exec();
  },
  del: async (keys) => {
    await client.del(...keys);
  },
});

export const cache = createCache({ store: redis ? upstashStore(redis) : null, prefix: env.REDIS_KEY_PREFIX, onError: warnRedis });

/**
 * Cache keys and TTLs. Only responses that are identical for every caller of the
 * endpoint are cached: public data (`public:`) and the admin-only dashboard
 * (`admin:`, read after authorize(ADMIN)). Role-scoped endpoints are never cached.
 */
export const CACHE_KEYS = {
  zones: "public:zones",
  hubs: "public:hubs",
  pricingEstimate: "public:pricing-estimate",
  tracking: (trackingId: string) => `public:tracking:${trackingId}`,
  dashboardStats: "admin:dashboard-stats",
} as const;

export const CACHE_TTL = {
  zones: 120,
  hubs: 120,
  pricingEstimate: 120,
  tracking: 15,
  dashboardStats: 60,
} as const;
