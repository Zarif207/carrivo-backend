import assert from "node:assert/strict";
import { describe, it } from "node:test";

// No external services: memory rate limits/cache (see middlewares/readOnly.test.ts).
process.env["UPSTASH_REDIS_REST_URL"] = "";
process.env["UPSTASH_REDIS_REST_TOKEN"] = "";

const { auth, withCustomerRole } = await import("../../lib/auth.js");
const { AuthValidation } = await import("./auth.validation.js");

/*
 * Registration and Google sign-in must never create ADMIN or ADMIN_VIEWER accounts.
 * Three layers: the request schema rejects a `role` field, Better Auth ignores client input for
 * `role` (input: false), and the user-create hook forces CUSTOMER for every new account
 * (both email sign-up and Google create users through that hook).
 */

const body = { name: "Pat Example", email: "pat@example.com", password: "Correct-Horse-9" };

describe("sign-up can't choose a role", () => {
  for (const role of ["ADMIN", "ADMIN_VIEWER", "COURIER", "CUSTOMER"]) {
    it(`POST /auth/register rejects a body with role=${role}`, () => {
      const parsed = AuthValidation.register.safeParse({ body: { ...body, role } });
      assert.equal(parsed.success, false);
    });
  }

  it("Google exchange accepts only code + verifier (no role)", () => {
    const valid = { code: "c".repeat(43), codeVerifier: "v".repeat(43) };
    assert.equal(AuthValidation.googleExchange.safeParse({ body: valid }).success, true);
    for (const role of ["ADMIN", "ADMIN_VIEWER"]) {
      assert.equal(AuthValidation.googleExchange.safeParse({ body: { ...valid, role } }).success, false);
    }
  });

  it("register accepts the same body without a role (so the rejections above are about role)", () => {
    assert.equal(AuthValidation.register.safeParse({ body }).success, true);
  });

  it("Better Auth treats role as server-only with a CUSTOMER default", () => {
    const role = auth.options.user?.additionalFields?.["role"];
    assert.ok(role);
    assert.equal(role.input, false);
    assert.equal(role.defaultValue, "CUSTOMER");
  });
});

describe("every new account is created as CUSTOMER", () => {
  it("withCustomerRole overrides any role", () => {
    for (const role of ["ADMIN", "ADMIN_VIEWER", "COURIER", undefined]) {
      assert.equal(withCustomerRole({ email: "a@example.com", role }).role, "CUSTOMER");
    }
  });

  it("the Better Auth user-create hook applies it (email sign-up and Google use the same hook)", async () => {
    const before = auth.options.databaseHooks?.user?.create?.before;
    assert.ok(before, "user.create.before hook is missing");
    for (const role of ["ADMIN", "ADMIN_VIEWER"]) {
      const result = await before({ id: "u1", email: "a@example.com", name: "A", emailVerified: false, createdAt: new Date(), updatedAt: new Date(), role });
      assert.ok(result && typeof result === "object" && "data" in result);
      assert.equal((result.data as { role: string }).role, "CUSTOMER");
    }
  });
});
