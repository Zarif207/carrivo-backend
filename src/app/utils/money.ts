import { Prisma } from "../../generated/prisma/client.js";

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
