import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCache, hashKey, type CacheStore } from "./cache.js";

/** In-memory Redis stand-in with a controllable clock and failure switch. */
const fakeStore = () => {
  let now = 0;
  let failing = false;
  const strings = new Map<string, { value: string; expiresAt: number }>();
  const hashes = new Map<string, { fields: Map<string, string>; expiresAt: number | null }>();
  const alive = (expiresAt: number | null) => expiresAt === null || expiresAt > now;
  const guard = () => {
    if (failing) throw new Error("redis down");
  };
  const store: CacheStore = {
    get: async (key) => {
      guard();
      const e = strings.get(key);
      return e && alive(e.expiresAt) ? e.value : null;
    },
    set: async (key, value, ttl) => {
      guard();
      strings.set(key, { value, expiresAt: now + ttl * 1000 });
    },
    hget: async (key, field) => {
      guard();
      const h = hashes.get(key);
      return h && alive(h.expiresAt) ? (h.fields.get(field) ?? null) : null;
    },
    hsetWithTtl: async (key, field, value, ttl) => {
      guard();
      let h = hashes.get(key);
      if (!h || !alive(h.expiresAt)) {
        h = { fields: new Map(), expiresAt: null };
        hashes.set(key, h);
      }
      h.fields.set(field, value);
      if (h.expiresAt === null) h.expiresAt = now + ttl * 1000; // EXPIRE NX
    },
    del: async (keys) => {
      guard();
      for (const key of keys) {
        strings.delete(key);
        hashes.delete(key);
      }
    },
  };
  return {
    store,
    advance: (ms: number) => (now += ms),
    fail: (on: boolean) => (failing = on),
    keys: () => [...strings.keys(), ...hashes.keys()],
  };
};

const counter = () => {
  let calls = 0;
  const load = async () => ({ n: (calls += 1), at: new Date("2026-11-06T00:00:00Z") });
  return { load, calls: () => calls };
};

describe("cache", () => {
  it("serves a hit without calling the loader, as JSON", async () => {
    const f = fakeStore();
    const errors: string[] = [];
    const cache = createCache({ store: f.store, prefix: "t:", onError: (op) => errors.push(op) });
    const c = counter();
    const first = await cache.getOrLoad("k", 60, c.load);
    const second = await cache.getOrLoad("k", 60, c.load);
    assert.equal(c.calls(), 1);
    assert.ok(first.at instanceof Date);
    // On the wire both are the same JSON.
    assert.equal(JSON.stringify(second), JSON.stringify(first));
    assert.deepEqual(f.keys(), ["t:k"]);
    assert.deepEqual(errors, []);
  });

  it("expires plain keys after their TTL", async () => {
    const f = fakeStore();
    const cache = createCache({ store: f.store, prefix: "", onError: () => undefined });
    const c = counter();
    await cache.getOrLoad("k", 15, c.load);
    f.advance(14_000);
    await cache.getOrLoad("k", 15, c.load);
    f.advance(2_000);
    await cache.getOrLoad("k", 15, c.load);
    assert.equal(c.calls(), 2);
  });

  it("invalidates every field of a hash with one delete", async () => {
    const f = fakeStore();
    const cache = createCache({ store: f.store, prefix: "", onError: () => undefined });
    const c = counter();
    await cache.getOrLoadField("zones", "list:a", 120, c.load);
    await cache.getOrLoadField("zones", "list:b", 120, c.load);
    await cache.getOrLoadField("zones", "list:a", 120, c.load);
    assert.equal(c.calls(), 2);
    await cache.invalidate("zones");
    await cache.getOrLoadField("zones", "list:a", 120, c.load);
    assert.equal(c.calls(), 3);
  });

  it("never lets hash fields outlive the TTL of the first fill (EXPIRE NX)", async () => {
    const f = fakeStore();
    const cache = createCache({ store: f.store, prefix: "", onError: () => undefined });
    const c = counter();
    await cache.getOrLoadField("h", "a", 120, c.load); // fill at t=0, expires t=120s
    f.advance(100_000);
    await cache.getOrLoadField("h", "b", 120, c.load); // must NOT extend the expiry
    f.advance(21_000); // t=121s
    await cache.getOrLoadField("h", "a", 120, c.load);
    assert.equal(c.calls(), 3);
  });

  it("fails open: store errors fall back to the loader and are reported", async () => {
    const f = fakeStore();
    const errors: string[] = [];
    const cache = createCache({ store: f.store, prefix: "", onError: (op) => errors.push(op) });
    const c = counter();
    f.fail(true);
    const v = await cache.getOrLoad("k", 60, c.load);
    assert.equal(v.n, 1);
    await cache.getOrLoadField("h", "x", 60, c.load);
    await cache.invalidate("k");
    assert.equal(c.calls(), 2);
    assert.deepEqual(errors, ["get", "set", "hget", "hset", "del"]);
  });

  it("works with no store at all (Redis not configured)", async () => {
    const cache = createCache({ store: null, prefix: "", onError: () => assert.fail("no errors expected") });
    const c = counter();
    await cache.getOrLoad("k", 60, c.load);
    await cache.getOrLoad("k", 60, c.load);
    await cache.invalidate("k");
    assert.equal(c.calls(), 2);
  });

  it("re-loads when a stored value is corrupt", async () => {
    const f = fakeStore();
    const cache = createCache({ store: f.store, prefix: "", onError: () => undefined });
    await f.store.set("k", "{not json", 60);
    const c = counter();
    await cache.getOrLoad("k", 60, c.load);
    assert.equal(c.calls(), 1);
  });
});

describe("hashKey", () => {
  it("is stable across key order and ignores undefined", () => {
    assert.equal(hashKey({ a: 1, b: "x", c: undefined }), hashKey({ b: "x", a: 1 }));
    assert.notEqual(hashKey({ a: 1 }), hashKey({ a: 2 }));
    assert.equal(hashKey({ d: new Date("2026-01-01T00:00:00Z") }), hashKey({ d: "2026-01-01T00:00:00.000Z" }));
  });
});
