import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkResetTarget, isDemoOrTestEmail, resetPhrase } from "./reset.safety.js";

const URL = "postgresql://user:secret@db-primary.example-host.test/carrivo?sslmode=require";
const HOST = "db-primary.example-host.test";

describe("checkResetTarget", () => {
  const ok = { nodeEnv: "production", databaseUrl: URL, confirmHost: HOST, resetConfirm: resetPhrase(HOST) };

  it("accepts the right host and the exact phrase", () => {
    assert.deepEqual(checkResetTarget(ok), { ok: true, host: HOST });
  });

  it("requires the host confirmation even outside production", () => {
    const result = checkResetTarget({ ...ok, nodeEnv: "development", confirmHost: undefined });
    assert.equal(result.ok, false);
  });

  it("refuses the wrong host", () => {
    const result = checkResetTarget({ ...ok, confirmHost: "db-other.example-host.test" });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /does not match/);
  });

  it("refuses a missing, generic or other-host phrase", () => {
    for (const resetConfirm of [undefined, "", "yes", "reset demo data", resetPhrase("db-other.example-host.test")]) {
      assert.equal(checkResetTarget({ ...ok, resetConfirm }).ok, false, String(resetConfirm));
    }
  });

  it("refuses a missing or unparsable DATABASE_URL", () => {
    assert.equal(checkResetTarget({ ...ok, databaseUrl: undefined }).ok, false);
    assert.equal(checkResetTarget({ ...ok, databaseUrl: "not a url" }).ok, false);
  });

  it("never echoes the database password", () => {
    const result = checkResetTarget({ ...ok, resetConfirm: "no" });
    assert.ok(!result.ok && !result.reason.includes("secret"));
  });
});

describe("isDemoOrTestEmail", () => {
  it("matches seeded and test accounts", () => {
    for (const email of ["admin@carrivo.dev", "Viewer@Carrivo.dev", "someone@example.com", "phase3.test.customer@gmail.test", "phase12.test.x@y.test"]) {
      assert.equal(isDemoOrTestEmail(email), true, email);
    }
  });
  it("keeps everyone else", () => {
    for (const email of ["jane@company.test", "carrivo.dev@mail.test", "user@example.com.evil.test", "myphase3.test@x.test"]) {
      assert.equal(isDemoOrTestEmail(email), false, email);
    }
  });
});
