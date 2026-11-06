import { createHash } from "node:crypto";

/**
 * Minimal Redis surface the cache needs. The Upstash client implements it in
 * production; unit tests pass an in-memory fake.
 */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  hget(key: string, field: string): Promise<string | null>;
  /** HSET, then EXPIRE … NX so the hash expires ttl after its FIRST fill. */
  hsetWithTtl(key: string, field: string, value: string, ttlSeconds: number): Promise<void>;
  del(keys: string[]): Promise<void>;
}

export interface CacheOptions {
  store: CacheStore | null;
  /** Applied to every key, e.g. "carrivo:v1:". */
  prefix: string;
  onError: (operation: string, error: unknown) => void;
}

/** Stable JSON (sorted keys) → short sha1, used as the hash field for a query/body. */
export const hashKey = (value: unknown): string => {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v instanceof Date) return v.toISOString();
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return createHash("sha1").update(JSON.stringify(stable(value))).digest("hex").slice(0, 20);
};

/**
 * Read-through cache that FAILS OPEN: any store error (or no store) means the
 * loader runs and its result is returned; errors are reported, never thrown.
 *
 * Values are stored as JSON. A hit returns the parsed JSON, which is exactly what
 * the API sends anyway (Dates are ISO strings on the wire either way).
 */
export const createCache = ({ store, prefix, onError }: CacheOptions) => {
  const k = (key: string): string => `${prefix}${key}`;

  const safe = async <T>(operation: string, fn: (s: CacheStore) => Promise<T>): Promise<T | undefined> => {
    if (!store) return undefined;
    try {
      return await fn(store);
    } catch (error) {
      onError(operation, error);
      return undefined;
    }
  };

  const parse = <T>(raw: string | null | undefined): T | undefined => {
    if (raw === null || raw === undefined) return undefined;
    try {
      // The value was produced by JSON.stringify of a T in this module.
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  };

  /** Plain key with its own TTL (e.g. tracking, dashboard). */
  const getOrLoad = async <T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> => {
    const hit = parse<T>(await safe("get", (s) => s.get(k(key))));
    if (hit !== undefined) return hit;
    const value = await load();
    await safe("set", (s) => s.set(k(key), JSON.stringify(value), ttlSeconds));
    return value;
  };

  /** Field inside a per-resource hash, so one DEL invalidates every variant (e.g. all list queries). */
  const getOrLoadField = async <T>(
    key: string,
    field: string,
    ttlSeconds: number,
    load: () => Promise<T>,
  ): Promise<T> => {
    const hit = parse<T>(await safe("hget", (s) => s.hget(k(key), field)));
    if (hit !== undefined) return hit;
    const value = await load();
    await safe("hset", (s) => s.hsetWithTtl(k(key), field, JSON.stringify(value), ttlSeconds));
    return value;
  };

  /** Call AFTER the write transaction commits. */
  const invalidate = async (...keys: string[]): Promise<void> => {
    if (keys.length === 0) return;
    await safe("del", (s) => s.del(keys.map(k)));
  };

  return { getOrLoad, getOrLoadField, invalidate };
};

export type Cache = ReturnType<typeof createCache>;
