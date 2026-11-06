/** Keys whose values must never appear in audit snapshots (checked case-insensitively). */
const SECRET_KEY = /pass(word)?|token|secret|hash|authorization|cookie|api[-_]?key/i;

export const REDACTED = "[REDACTED]";

/**
 * Deep copy with secret-looking keys replaced by "[REDACTED]". Applied when an
 * audit row is written AND when audit logs are read back, as defense in depth.
 */
export const redactSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, SECRET_KEY.test(key) ? REDACTED : redactSecrets(v)]),
    );
  }
  return value;
};
