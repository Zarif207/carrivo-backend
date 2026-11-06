import { MemoryStore, type IncrementResponse, type Options, type Store } from "express-rate-limit";

/** The three Redis operations the limiter needs. Upstash implements them in lib/redis-backed code. */
export interface RateLimitBackend {
  /** INCR key; PEXPIRE key windowMs NX; PTTL key: in one round trip. */
  incrementWithTtl(key: string, windowMs: number): Promise<{ totalHits: number; ttlMs: number }>;
  decrement(key: string): Promise<void>;
  reset(key: string): Promise<void>;
}

export interface RedisRateLimitStoreOptions {
  backend: RateLimitBackend | null;
  /** Full key prefix, e.g. "carrivo:v1:rl:auth:". */
  prefix: string;
  onError: (operation: string, error: unknown) => void;
}

/**
 * express-rate-limit Store backed by Redis, shared across serverless instances.
 * If Redis is missing or a call fails, that request is counted in an in-memory
 * MemoryStore instead, so limits degrade to per-instance rather than disappearing.
 */
export class RedisRateLimitStore implements Store {
  readonly prefix: string;
  /** Counters live in Redis, not in this process. */
  readonly localKeys = false;
  private windowMs = 60_000;
  private readonly fallback = new MemoryStore();
  private readonly backend: RateLimitBackend | null;
  private readonly onError: RedisRateLimitStoreOptions["onError"];

  constructor({ backend, prefix, onError }: RedisRateLimitStoreOptions) {
    this.backend = backend;
    this.prefix = prefix;
    this.onError = onError;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  async increment(key: string): Promise<IncrementResponse> {
    if (this.backend) {
      try {
        const { totalHits, ttlMs } = await this.backend.incrementWithTtl(this.prefix + key, this.windowMs);
        const ttl = ttlMs > 0 ? ttlMs : this.windowMs;
        return { totalHits, resetTime: new Date(Date.now() + ttl) };
      } catch (error) {
        this.onError("rate-limit increment", error);
      }
    }
    return this.fallback.increment(key);
  }

  async decrement(key: string): Promise<void> {
    if (this.backend) {
      try {
        await this.backend.decrement(this.prefix + key);
        return;
      } catch (error) {
        this.onError("rate-limit decrement", error);
      }
    }
    await this.fallback.decrement(key);
  }

  async resetKey(key: string): Promise<void> {
    if (this.backend) {
      try {
        await this.backend.reset(this.prefix + key);
      } catch (error) {
        this.onError("rate-limit reset", error);
      }
    }
    await this.fallback.resetKey(key);
  }

  shutdown(): void {
    this.fallback.shutdown();
  }
}
