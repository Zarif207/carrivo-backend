import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Options } from "express-rate-limit";
import { RedisRateLimitStore, type RateLimitBackend } from "./redisRateLimitStore.js";

const fakeBackend = () => {
  const counts = new Map<string, number>();
  let failing = false;
  const backend: RateLimitBackend = {
    incrementWithTtl: async (key) => {
      if (failing) throw new Error("redis down");
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { totalHits: n, ttlMs: 900_000 };
    },
    decrement: async (key) => {
      if (failing) throw new Error("redis down");
      counts.set(key, (counts.get(key) ?? 0) - 1);
    },
    reset: async (key) => {
      if (failing) throw new Error("redis down");
      counts.delete(key);
    },
  };
  return { backend, counts, fail: (on: boolean) => (failing = on) };
};

const options = { windowMs: 900_000 } as Options;

describe("RedisRateLimitStore", () => {
  it("counts in Redis under the prefix", async () => {
    const f = fakeBackend();
    const store = new RedisRateLimitStore({ backend: f.backend, prefix: "rl:auth:", onError: () => undefined });
    store.init(options);
    await store.increment("1.2.3.4");
    const r = await store.increment("1.2.3.4");
    assert.equal(r.totalHits, 2);
    assert.ok(r.resetTime && r.resetTime.getTime() > Date.now());
    assert.deepEqual([...f.counts.keys()], ["rl:auth:1.2.3.4"]);
    store.shutdown();
  });

  it("decrements (skipSuccessfulRequests) and resets", async () => {
    const f = fakeBackend();
    const store = new RedisRateLimitStore({ backend: f.backend, prefix: "p:", onError: () => undefined });
    store.init(options);
    await store.increment("ip");
    await store.increment("ip");
    await store.decrement("ip");
    assert.equal(f.counts.get("p:ip"), 1);
    await store.resetKey("ip");
    assert.equal(f.counts.has("p:ip"), false);
    store.shutdown();
  });

  it("falls back to the in-memory store when Redis fails (never fails closed or open)", async () => {
    const f = fakeBackend();
    const errors: string[] = [];
    const store = new RedisRateLimitStore({ backend: f.backend, prefix: "p:", onError: (op) => errors.push(op) });
    store.init(options);
    f.fail(true);
    // MemoryStore returns the same mutable object each time, so capture the numbers.
    const a = (await store.increment("ip")).totalHits;
    const b = (await store.increment("ip")).totalHits;
    assert.equal(a, 1);
    assert.equal(b, 2); // still limited, per instance
    assert.deepEqual(errors, ["rate-limit increment", "rate-limit increment"]);
    store.shutdown();
  });

  it("uses only memory when Redis is not configured", async () => {
    const store = new RedisRateLimitStore({ backend: null, prefix: "p:", onError: () => assert.fail("no errors") });
    store.init(options);
    await store.increment("ip");
    assert.equal((await store.increment("ip")).totalHits, 2);
    store.shutdown();
  });
});
