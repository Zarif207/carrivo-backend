import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHALLENGE_PATTERN,
  EXCHANGE_CODE_PATTERN,
  exchangeIdentifier,
  mapGoogleError,
  newExchangeCode,
  readCookie,
  s256,
  signValue,
  unsignValue,
  verifyChallenge,
} from "./auth.google.utils.js";

describe("PKCE challenge (S256)", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    assert.equal(s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("verifies the right verifier and rejects others", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = s256(verifier);
    assert.ok(CHALLENGE_PATTERN.test(challenge));
    assert.equal(verifyChallenge(verifier, challenge), true);
    assert.equal(verifyChallenge(`${verifier}x`, challenge), false);
    assert.equal(verifyChallenge("short", s256("short")), false); // under 43 chars
    assert.equal(verifyChallenge(verifier, "not-a-challenge"), false);
  });
});

describe("one-time exchange code", () => {
  it("is 43 base64url chars, random, and stored only as a hash", () => {
    const a = newExchangeCode();
    const b = newExchangeCode();
    assert.ok(EXCHANGE_CODE_PATTERN.test(a));
    assert.notEqual(a, b);
    const id = exchangeIdentifier(a);
    assert.ok(id.startsWith("carrivo:google-exchange:"));
    assert.ok(!id.includes(a));
    assert.equal(id, exchangeIdentifier(a));
  });
});

describe("signed challenge cookie", () => {
  it("round-trips and rejects tampering or the wrong secret", () => {
    const secret = "s".repeat(32);
    const signed = signValue("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", secret);
    assert.equal(unsignValue(signed, secret), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    assert.equal(unsignValue(signed.replace(/^E/, "F"), secret), null);
    assert.equal(unsignValue(signed, "t".repeat(32)), null);
    assert.equal(unsignValue("nodot", secret), null);
    assert.equal(unsignValue(undefined, secret), null);
  });

  it("reads one cookie from a Cookie header", () => {
    const header = "a=1; carrivo_google_challenge=abc.def%3D; better-auth.session_token=x.y";
    assert.equal(readCookie(header, "carrivo_google_challenge"), "abc.def=");
    assert.equal(readCookie(header, "missing"), undefined);
    assert.equal(readCookie(undefined, "a"), undefined);
  });
});

describe("mapGoogleError", () => {
  it("maps Better Auth / Google errors to the fixed frontend set", () => {
    assert.equal(mapGoogleError("account_not_linked"), "account_exists");
    assert.equal(mapGoogleError("ACCOUNT_DEACTIVATED"), "account_deactivated");
    assert.equal(mapGoogleError("access_denied"), "google_cancelled");
    assert.equal(mapGoogleError("state_mismatch"), "google_failed");
    assert.equal(mapGoogleError("<script>"), "google_failed");
    assert.equal(mapGoogleError(undefined), "google_failed");
  });
});
