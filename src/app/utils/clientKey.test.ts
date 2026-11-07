import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ipKeyGenerator } from "express-rate-limit";
import { rateLimitKey, secretMatches, trustedClientIp, type KeyedRequest } from "./clientKey.js";

const SECRET = "s3cret-value-that-is-at-least-32-characters-long";
const CONNECTING_IP = "203.0.113.10"; // the frontend server as seen by the API

const req = (headers: KeyedRequest["headers"], ip: string | undefined = CONNECTING_IP): KeyedRequest => ({ headers, ip });

describe("rateLimitKey", () => {
  it("valid secret + valid IPv4 uses the forwarded IP", () => {
    const r = req({ "x-bff-secret": SECRET, "x-client-ip": "198.51.100.7" });
    assert.equal(rateLimitKey(r, SECRET), "198.51.100.7");
  });

  it("valid secret + valid IPv6 uses the forwarded IP (grouped by subnet like the default)", () => {
    const r = req({ "x-bff-secret": SECRET, "x-client-ip": "2001:db8:abcd:12::1" });
    assert.equal(rateLimitKey(r, SECRET), ipKeyGenerator("2001:db8:abcd:12::1"));
  });

  it("wrong secret ignores the header", () => {
    const r = req({ "x-bff-secret": `${SECRET}-nope`, "x-client-ip": "198.51.100.7" });
    assert.equal(rateLimitKey(r, SECRET), CONNECTING_IP);
  });

  it("missing secret header ignores the forwarded IP", () => {
    const r = req({ "x-client-ip": "198.51.100.7" });
    assert.equal(rateLimitKey(r, SECRET), CONNECTING_IP);
  });

  it("no secret configured on the server ignores both headers", () => {
    const r = req({ "x-bff-secret": SECRET, "x-client-ip": "198.51.100.7" });
    assert.equal(rateLimitKey(r, undefined), CONNECTING_IP);
    assert.equal(rateLimitKey(req({ "x-bff-secret": "", "x-client-ip": "198.51.100.7" }), ""), CONNECTING_IP);
  });

  it("garbage IP is ignored even with the right secret", () => {
    for (const bad of ["not-an-ip", "999.1.1.1", "198.51.100.7, 10.0.0.1", "", "<script>"]) {
      const r = req({ "x-bff-secret": SECRET, "x-client-ip": bad });
      assert.equal(rateLimitKey(r, SECRET), CONNECTING_IP, `should ignore ${JSON.stringify(bad)}`);
    }
  });

  it("repeated headers (arrays) are not trusted", () => {
    const r = req({ "x-bff-secret": [SECRET, SECRET], "x-client-ip": "198.51.100.7" });
    assert.equal(rateLimitKey(r, SECRET), CONNECTING_IP);
    const r2 = req({ "x-bff-secret": SECRET, "x-client-ip": ["198.51.100.7", "198.51.100.8"] });
    assert.equal(rateLimitKey(r2, SECRET), CONNECTING_IP);
  });

  it("trims whitespace around the forwarded IP", () => {
    assert.equal(trustedClientIp(req({ "x-bff-secret": SECRET, "x-client-ip": "  198.51.100.7 " }), SECRET), "198.51.100.7");
  });

  it("falls back to the default key for the connecting IP (IPv6 subnet grouping kept)", () => {
    assert.equal(rateLimitKey(req({}, "2001:db8::42"), SECRET), ipKeyGenerator("2001:db8::42"));
    assert.equal(rateLimitKey({ headers: {} }, SECRET), "unknown");
  });
});

describe("secretMatches", () => {
  it("is true only for the exact secret", () => {
    assert.equal(secretMatches(SECRET, SECRET), true);
    assert.equal(secretMatches(SECRET.slice(0, -1), SECRET), false);
    assert.equal(secretMatches(`${SECRET} `, SECRET), false);
    assert.equal(secretMatches(undefined, SECRET), false);
    assert.equal(secretMatches(SECRET, undefined), false);
  });
});
