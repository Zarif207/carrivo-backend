/**
 * Pure guards for prisma/seed.ts (unit-tested in seed.safety.test.ts).
 *
 * Production seeding (NODE_ENV=production) is deliberately harder than local:
 * - SEED_CONFIRM_DB_HOST must equal the host the seed is about to write to, so a
 *   copy-pasted command can never seed the wrong database by accident;
 * - SEED_DEMO_PASSWORD must be strong, because the demo accounts (including the
 *   ADMIN) are public in the submission and live on the internet.
 *
 * Nothing here ever returns or prints the password itself.
 */

export const STRONG_PASSWORD_MIN_LENGTH = 16;
export const BASIC_PASSWORD_MIN_LENGTH = 8;

/** Substrings that make a demo password guessable from the project itself. */
const GUESSABLE = ["password", "carrivo", "123456", "qwerty", "admin", "demo"];

/** Problems with the password (empty list = acceptable). Never echoes the value. */
export const demoPasswordProblems = (password: string | undefined, strict: boolean): string[] => {
  if (!password) return ["SEED_DEMO_PASSWORD is not set."];
  const problems: string[] = [];
  const minLength = strict ? STRONG_PASSWORD_MIN_LENGTH : BASIC_PASSWORD_MIN_LENGTH;
  if (password.length < minLength) problems.push(`it must be at least ${minLength} characters (it has ${password.length}).`);
  if (!strict) return problems;

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
  if (classes < 3) problems.push("it must mix at least 3 of: lowercase, uppercase, digits, symbols.");
  const lower = password.toLowerCase();
  const found = GUESSABLE.filter((word) => lower.includes(word));
  if (found.length > 0) problems.push(`it must not contain guessable words (${found.join(", ")}).`);
  if (/(.)\1{3,}/.test(password)) problems.push("it must not repeat one character 4+ times in a row.");
  return problems;
};

/** Host only (no user, password or database name), or null when unparsable. */
export const databaseHost = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
};

export type SeedTargetCheck = { ok: true; host: string } | { ok: false; reason: string };

/**
 * In production the operator must name the target host explicitly. Outside
 * production any parsable URL is accepted (local dev may also use a cloud DB).
 */
export const checkSeedTarget = (input: {
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
  confirmHost: string | undefined;
}): SeedTargetCheck => {
  const host = databaseHost(input.databaseUrl);
  if (!host) return { ok: false, reason: "DATABASE_URL is missing or not a valid URL." };
  if (input.nodeEnv !== "production") return { ok: true, host };
  const confirm = input.confirmHost?.trim().toLowerCase();
  if (!confirm) {
    return { ok: false, reason: `NODE_ENV=production: set SEED_CONFIRM_DB_HOST=${host} to confirm this is the database you mean to seed.` };
  }
  if (confirm !== host.toLowerCase()) {
    return { ok: false, reason: `SEED_CONFIRM_DB_HOST (${confirm}) does not match the DATABASE_URL host (${host}). Nothing was written.` };
  }
  return { ok: true, host };
};
