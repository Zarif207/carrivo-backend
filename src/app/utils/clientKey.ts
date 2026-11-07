import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { ipKeyGenerator } from "express-rate-limit";

/*
 * Rate-limit key for a request. The Next.js frontend calls this API from its own server (BFF), so every
 * visitor would otherwise share the frontend server's IP. The BFF forwards the visitor's IP in
 * `x-client-ip` together with `x-bff-secret`. The forwarded IP is trusted ONLY when the secret matches
 * BFF_SHARED_SECRET (timing-safe) and the value is a valid IPv4/IPv6 address; otherwise the key is the
 * connecting IP, exactly as before. Pure (no env import) so it can be unit tested.
 */

export const BFF_SECRET_HEADER = "x-bff-secret";
export const CLIENT_IP_HEADER = "x-client-ip";

type HeaderValue = string | string[] | undefined;

export interface KeyedRequest {
  headers: Record<string, HeaderValue>;
  ip?: string | undefined;
}

const single = (value: HeaderValue): string | undefined => (typeof value === "string" ? value : undefined);

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** Constant-time comparison; hashing first makes both sides the same length. */
export function secretMatches(provided: HeaderValue, expected: string | undefined): boolean {
  const value = single(provided);
  if (!expected || !value) return false;
  return timingSafeEqual(digest(value), digest(expected));
}

/** The forwarded visitor IP, or null unless the secret matches and the value is a real IP address. */
export function trustedClientIp(req: KeyedRequest, secret: string | undefined): string | null {
  if (!secretMatches(req.headers[BFF_SECRET_HEADER], secret)) return null;
  const ip = single(req.headers[CLIENT_IP_HEADER])?.trim();
  return ip && isIP(ip) !== 0 ? ip : null;
}

/**
 * Key for express-rate-limit. Both paths go through ipKeyGenerator so IPv6 addresses are grouped by
 * subnet the same way as the library's default key generator.
 */
export function rateLimitKey(req: KeyedRequest, secret: string | undefined): string {
  const ip = trustedClientIp(req, secret) ?? req.ip;
  return ip ? ipKeyGenerator(ip) : "unknown";
}
