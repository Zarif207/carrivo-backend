import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Pure helpers for the Google sign-in handoff (unit-tested):
 * PKCE-style challenge/verifier (RFC 7636, S256), the one-time exchange code,
 * the signed challenge cookie, and mapping Better Auth errors to a fixed set.
 */

/** base64url(SHA-256(x)) is always 43 chars, no padding. */
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636: 43-128 chars from the unreserved set. */
export const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
/** 32 random bytes as base64url = 43 chars. */
export const EXCHANGE_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const EXCHANGE_CODE_TTL_MS = 60_000;
export const EXCHANGE_IDENTIFIER_PREFIX = "carrivo:google-exchange:";

export const s256 = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** True when SHA-256(verifier) matches the challenge sent at the start of the flow. */
export const verifyChallenge = (verifier: string, challenge: string): boolean =>
  VERIFIER_PATTERN.test(verifier) && CHALLENGE_PATTERN.test(challenge) && safeEqual(s256(verifier), challenge);

export const newExchangeCode = (): string => randomBytes(32).toString("base64url");

/** Only the hash is stored, so a database read never reveals a usable code. */
export const exchangeIdentifier = (code: string): string =>
  `${EXCHANGE_IDENTIFIER_PREFIX}${createHash("sha256").update(code).digest("hex")}`;

/** `<value>.<HMAC-SHA256>`, so the challenge cookie can't be swapped by the client. */
export const signValue = (value: string, secret: string): string =>
  `${value}.${createHmac("sha256", secret).update(value).digest("base64url")}`;

export const unsignValue = (signed: string | undefined, secret: string): string | null => {
  if (!signed) return null;
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  return safeEqual(signValue(value, secret), signed) ? value : null;
};

/** Minimal Cookie header parser (we only read our own cookie). */
export const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
};

/** The ONLY error values the frontend ever receives (Better Auth's raw codes/descriptions never pass through). */
export type GoogleErrorCode = "account_exists" | "account_deactivated" | "google_cancelled" | "google_failed";

export const mapGoogleError = (raw: string | undefined): GoogleErrorCode => {
  switch ((raw ?? "").toLowerCase()) {
    case "account_not_linked":
      return "account_exists";
    case "account_deactivated":
      return "account_deactivated";
    case "access_denied":
      return "google_cancelled";
    default:
      return "google_failed";
  }
};
