import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adminPasswordProblems, checkSeedTarget, databaseHost, demoPasswordProblems } from "./seed.safety.js";

const NEON = "postgresql://user:secret@db-primary.example-host.test/carrivo?sslmode=require";
const HOST = "db-primary.example-host.test";

describe("demoPasswordProblems", () => {
  it("local (non-strict): only requires 8 characters", () => {
    assert.deepEqual(demoPasswordProblems("devpass1", false), []);
    assert.equal(demoPasswordProblems("short", false).length, 1);
    assert.deepEqual(demoPasswordProblems(undefined, false), ["SEED_DEMO_PASSWORD is not set."]);
  });

  it("production (strict): accepts a long mixed password", () => {
    assert.deepEqual(demoPasswordProblems("Vq7#mTz9!kLw2@Rb", true), []);
    assert.deepEqual(demoPasswordProblems("tidal-Lantern-84-orbit", true), []);
  });

  it("production (strict): rejects short, single-class, guessable and repetitive passwords", () => {
    assert.match(demoPasswordProblems("Ab1!Ab1!", true).join(" "), /at least 16/);
    assert.match(demoPasswordProblems("abcdefghijklmnopqrst", true).join(" "), /at least 3 of/);
    assert.match(demoPasswordProblems("Carrivo-Password-2026!", true).join(" "), /guessable words \(password, carrivo\)/);
    assert.match(demoPasswordProblems("Xyz1!aaaaBcd9#Qrs", true).join(" "), /repeat/);
  });

  it("never includes the password in its messages", () => {
    const secret = "Carrivo-Password-1";
    for (const problem of demoPasswordProblems(secret, true)) assert.ok(!problem.includes(secret));
  });
});

describe("checkSeedTarget", () => {
  it("returns the host only, never credentials", () => {
    assert.equal(databaseHost(NEON), HOST);
    assert.equal(databaseHost("not a url"), null);
  });

  it("outside production: any valid URL is fine without confirmation", () => {
    assert.deepEqual(checkSeedTarget({ nodeEnv: "development", databaseUrl: NEON, confirmHost: undefined }), { ok: true, host: HOST });
    assert.deepEqual(checkSeedTarget({ nodeEnv: undefined, databaseUrl: NEON, confirmHost: undefined }), { ok: true, host: HOST });
  });

  it("production: requires SEED_CONFIRM_DB_HOST to match the DATABASE_URL host", () => {
    const missing = checkSeedTarget({ nodeEnv: "production", databaseUrl: NEON, confirmHost: undefined });
    assert.ok(!missing.ok && missing.reason.includes(`SEED_CONFIRM_DB_HOST=${HOST}`));
    const wrong = checkSeedTarget({ nodeEnv: "production", databaseUrl: NEON, confirmHost: "db-other.example-host.test" });
    assert.ok(!wrong.ok && wrong.reason.includes("does not match"));
    assert.deepEqual(checkSeedTarget({ nodeEnv: "production", databaseUrl: NEON, confirmHost: ` ${HOST.toUpperCase()} ` }), { ok: true, host: HOST });
  });

  it("error messages never contain the connection string's password", () => {
    const result = checkSeedTarget({ nodeEnv: "production", databaseUrl: NEON, confirmHost: "x" });
    assert.ok(!result.ok && !result.reason.includes("secret"));
  });

  it("rejects a missing or invalid DATABASE_URL", () => {
    assert.equal(checkSeedTarget({ nodeEnv: "production", databaseUrl: undefined, confirmHost: HOST }).ok, false);
  });
});

describe("adminPasswordProblems", () => {
  const demo = "Tr4ck-Parcels-Fast!";
  it("is optional: unset means the admin keeps the demo password", () => {
    assert.deepEqual(adminPasswordProblems(undefined, demo, true), []);
  });
  it("uses the same strength rules as the demo password, named after its own variable", () => {
    const problems = adminPasswordProblems("short", demo, true);
    assert.ok(problems.length > 0);
    assert.deepEqual(adminPasswordProblems("", demo, true), ["SEED_ADMIN_PASSWORD is not set."]);
  });
  it("must differ from the demo password", () => {
    assert.ok(adminPasswordProblems(demo, demo, true).some((p) => p.includes("differ")));
    assert.deepEqual(adminPasswordProblems("Ops-Console-91-Keys", demo, true), []);
  });
});
