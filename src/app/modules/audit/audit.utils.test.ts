import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REDACTED, redactSecrets } from "./audit.utils.js";

describe("redactSecrets", () => {
  it("redacts secret-looking keys at any depth and keeps the rest", () => {
    const input = {
      email: "a@b.dev",
      password: "hunter22",
      trackingId: "CRV-261101-SEED01",
      nested: { sessionToken: "abc", refresh_token: "x", passwordHash: "h", apiKey: "k", ok: 1 },
      list: [{ accessToken: "t", name: "n" }],
      createdAt: new Date("2026-11-06T00:00:00Z"),
    };
    assert.deepEqual(redactSecrets(input), {
      email: "a@b.dev",
      password: REDACTED,
      trackingId: "CRV-261101-SEED01",
      nested: { sessionToken: REDACTED, refresh_token: REDACTED, passwordHash: REDACTED, apiKey: REDACTED, ok: 1 },
      list: [{ accessToken: REDACTED, name: "n" }],
      createdAt: input.createdAt,
    });
  });

  it("leaves primitives and null alone", () => {
    assert.equal(redactSecrets(null), null);
    assert.equal(redactSecrets("token"), "token");
    assert.equal(redactSecrets(5), 5);
  });
});
