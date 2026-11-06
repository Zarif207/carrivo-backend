import { Prisma } from "../../generated/prisma/client.js";
import { MINOR_UNITS_PER_MAJOR } from "../config/currency.js";

/**
 * Every money amount in an API response is a 2-decimal string ("160.00").
 * Prisma's Decimal serializes without trailing zeros ("160"), so services run
 * their rows through these helpers before returning them.
 */
export const formatMoney = (value: Prisma.Decimal | number | string): string =>
  new Prisma.Decimal(value).toFixed(2, Prisma.Decimal.ROUND_HALF_UP);

/** Keys of T whose value is a Decimal (or Decimal | null). */
type MoneyKey<T> = {
  [K in keyof T]-?: T[K] extends Prisma.Decimal | null ? K : never;
}[keyof T];

/** T with the given Decimal fields replaced by strings (nullable stays nullable). */
export type WithMoney<T, K extends MoneyKey<T>> = Omit<T, K> & {
  [P in K]: null extends T[P] ? string | null : string;
};

export const formatMoneyFields = <T extends object, K extends MoneyKey<T>>(
  row: T,
  keys: readonly K[],
): WithMoney<T, K> => {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const key of keys) {
    const value = row[key] as Prisma.Decimal | null;
    out[key as string] = value === null ? null : formatMoney(value);
  }
  return out as WithMoney<T, K>;
};

/**
 * Major units (Decimal, e.g. 6.00) → Stripe minor units (integer cents, e.g. 600).
 * Decimal math only; throws if the amount has more precision than a cent.
 */
export const toMinorUnits = (value: Prisma.Decimal | number | string): number => {
  const minor = new Prisma.Decimal(value).times(MINOR_UNITS_PER_MAJOR);
  if (!minor.isInteger()) throw new RangeError(`Amount ${String(value)} has sub-cent precision`);
  if (minor.isNegative()) throw new RangeError(`Amount ${String(value)} is negative`);
  if (minor.greaterThan(Number.MAX_SAFE_INTEGER)) throw new RangeError(`Amount ${String(value)} is too large`);
  return minor.toNumber();
};

/** Stripe minor units (integer cents) → major units as a Decimal. */
export const fromMinorUnits = (minor: number): Prisma.Decimal => {
  if (!Number.isSafeInteger(minor)) throw new RangeError(`Minor amount ${minor} is not an integer`);
  return new Prisma.Decimal(minor).dividedBy(MINOR_UNITS_PER_MAJOR);
};
