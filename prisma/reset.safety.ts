/**
 * Pure guards for prisma/reset-demo.ts (unit-tested in reset.safety.test.ts).
 *
 * Resetting deletes data, so it is stricter than seeding, in every environment:
 * - SEED_CONFIRM_DB_HOST must equal the DATABASE_URL host (same rule as the seed);
 * - RESET_CONFIRM must be the exact phrase "reset demo data on <host>", so the
 *   operator types the host a second time and a copied command for another database
 *   can never match.
 */
import { checkSeedTarget, databaseHost } from "./seed.safety.js";

export const resetPhrase = (host: string): string => `reset demo data on ${host}`;

export type ResetTargetCheck = { ok: true; host: string } | { ok: false; reason: string };

export const checkResetTarget = (input: {
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
  confirmHost: string | undefined;
  resetConfirm: string | undefined;
}): ResetTargetCheck => {
  const host = databaseHost(input.databaseUrl);
  if (!host) return { ok: false, reason: "DATABASE_URL is missing or not a valid URL." };
  // The host confirmation applies even outside production: a reset deletes data.
  const target = checkSeedTarget({ nodeEnv: "production", databaseUrl: input.databaseUrl, confirmHost: input.confirmHost });
  if (!target.ok) return target;
  if (input.resetConfirm?.trim() !== resetPhrase(host)) {
    return { ok: false, reason: `set RESET_CONFIRM="${resetPhrase(host)}" to confirm the reset. Nothing was deleted.` };
  }
  return { ok: true, host };
};

/** Seeded demo accounts and accounts created while testing. Every other user is kept. */
export const isDemoOrTestEmail = (email: string): boolean => {
  const value = email.trim().toLowerCase();
  return value.endsWith("@carrivo.dev") || value.endsWith("@example.com") || /^phase\d+\.test\./.test(value);
};
