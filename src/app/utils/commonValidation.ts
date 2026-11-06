import { z } from "zod";

/** `:id` route param. All our ids are UUIDs (v7 for domain rows, v4 for users). */
export const idParams = z.strictObject({
  id: z.uuid({ message: "Invalid id" }),
});

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9\s-]{7,20}$/, { message: "Phone must be 7-20 digits, optionally with +, spaces or dashes" });

/** Rounds to 2 decimals (money and kg are stored as Decimal(_, 2)). */
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Non-negative amount in the platform currency (USD), at most 2 decimals after rounding. */
export const moneySchema = z
  .number({ message: "Must be a number" })
  .min(0, { message: "Must be 0 or more" })
  .max(99_999_999, { message: "Amount is too large" })
  .transform(round2);

/** Parcel weight in kg: > 0, rounded to 2 decimals, hard cap 1000 kg (rules may cap lower). */
export const weightSchema = z
  .number({ message: "Weight must be a number" })
  .positive({ message: "Weight must be greater than 0" })
  .max(1000, { message: "Weight cannot exceed 1000 kg" })
  .transform(round2)
  .refine((value) => value > 0, { message: "Weight must be at least 0.01 kg" });
