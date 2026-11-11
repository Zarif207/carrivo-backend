/**
 * Pure guards for prisma/seed-couriers.ts (unit-tested in seed-couriers.test.ts).
 *
 * The courier seed only adds rows, but it is meant to run against production one day, so:
 * - SEED_CONFIRM_DB_HOST must equal the DATABASE_URL host, always (dry runs included);
 * - writing to a database that is not local also needs SEED_COURIERS_CONFIRM set to the exact
 *   phrase "seed couriers on <host>" (the operator types the host twice);
 * - SEED_COURIER_LOGIN_PASSWORD is optional; when set it must pass the demo-password rules
 *   (strict ones off localhost). Unset, every account gets a random password nobody knows.
 */
import { databaseHost, demoPasswordProblems } from "./seed.safety.js";

export const courierSeedPhrase = (host: string): string => `seed couriers on ${host}`;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export const isLocalHost = (host: string): boolean => LOCAL_HOSTS.has(host.toLowerCase());

export type CourierSeedTargetCheck = { ok: true; host: string; local: boolean } | { ok: false; reason: string };

export const checkCourierSeedTarget = (input: {
  databaseUrl: string | undefined;
  confirmHost: string | undefined;
  confirmPhrase: string | undefined;
  loginPassword: string | undefined;
  dryRun: boolean;
}): CourierSeedTargetCheck => {
  const host = databaseHost(input.databaseUrl);
  if (!host) return { ok: false, reason: "DATABASE_URL is missing or not a valid URL." };
  const confirm = input.confirmHost?.trim().toLowerCase();
  if (!confirm) return { ok: false, reason: `set SEED_CONFIRM_DB_HOST=${host} to confirm the target database. Nothing was read or written.` };
  if (confirm !== host.toLowerCase()) {
    return { ok: false, reason: `SEED_CONFIRM_DB_HOST (${confirm}) does not match the DATABASE_URL host (${host}). Nothing was read or written.` };
  }
  const local = isLocalHost(host);
  if (!input.dryRun && !local && input.confirmPhrase?.trim() !== courierSeedPhrase(host)) {
    return { ok: false, reason: `${host} is not a local database: set SEED_COURIERS_CONFIRM="${courierSeedPhrase(host)}" to write to it. Nothing was written.` };
  }
  if (input.loginPassword !== undefined) {
    const problems = demoPasswordProblems(input.loginPassword, !local, "SEED_COURIER_LOGIN_PASSWORD");
    if (problems.length > 0) return { ok: false, reason: `SEED_COURIER_LOGIN_PASSWORD: ${problems.join(" ")}` };
  }
  return { ok: true, host, local };
};
