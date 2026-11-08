import { z } from "zod";

/** `:id` route param. All our ids are UUIDs (v7 for domain rows, v4 for users). */
export const idParams = z.strictObject({
  id: z.uuid({ message: "Invalid id" }),
});

/*
 * US formats (the platform operates in the United States).
 * Phone: a North American number, optional +1, common separators: (212) 555-0142, 212-555-0142,
 * 212.555.0142, 2125550142, +1 212 555 0142. Area code and exchange can't start with 0 or 1.
 */
export const US_PHONE_PATTERN = /^(?:\+?1[\s.-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[\s.-]?[2-9]\d{2}[\s.-]?\d{4}$/;
export const US_PHONE_MESSAGE = "Enter a US phone number, e.g. (212) 555-0142 or +1 212-555-0142";

export const phoneSchema = z.string().trim().regex(US_PHONE_PATTERN, { message: US_PHONE_MESSAGE });

/** USPS codes for the 50 states and DC. */
export const US_STATE_CODES: ReadonlySet<string> = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "),
);

export const US_ADDRESS_MESSAGE = "Use a US address: street, city, state, ZIP (e.g. 350 5th Ave, New York, NY 10118)";

/** "street, City, ST 12345" or "...-6789" (ZIP+4). Returns the address with the state upper-cased, or null. */
export function normalizeUsAddress(value: string): string | null {
  const match = /^(.+?),\s*([A-Za-z][A-Za-z .'-]*?)\s*,\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(value.trim());
  if (!match) return null;
  const [, street, city, state, zip] = match as unknown as [string, string, string, string, string];
  const code = state.toUpperCase();
  if (!US_STATE_CODES.has(code) || street.trim().length < 3) return null;
  return `${street.trim()}, ${city.trim()}, ${code} ${zip}`;
}

/** A full US street address in one line (5-300 chars), stored with an upper-case state code. */
export const usAddressSchema = z
  .string()
  .trim()
  .min(5, { message: "Address must be at least 5 characters" })
  .max(300, { message: "Address must be at most 300 characters" })
  .transform((value, ctx) => {
    const normalized = normalizeUsAddress(value);
    if (normalized === null) {
      ctx.addIssue({ code: "custom", message: US_ADDRESS_MESSAGE });
      return z.NEVER;
    }
    return normalized;
  });

/** Rounds to 2 decimals (money and pounds are stored as Decimal(_, 2)). */
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Non-negative amount in the platform currency (USD), at most 2 decimals after rounding. */
export const moneySchema = z
  .number({ message: "Must be a number" })
  .min(0, { message: "Must be 0 or more" })
  .max(99_999_999, { message: "Amount is too large" })
  .transform(round2);

/** Heaviest parcel the platform accepts, in pounds (about 907 kg). */
export const MAX_WEIGHT_LB = 2000;

/** Parcel weight in pounds (lb): > 0, rounded to 2 decimals, hard cap 2,000 lb (rules may cap lower). */
export const weightSchema = z
  .number({ message: "Weight must be a number" })
  .positive({ message: "Weight must be greater than 0" })
  .max(MAX_WEIGHT_LB, { message: `Weight cannot exceed ${MAX_WEIGHT_LB.toLocaleString("en-US")} lb` })
  .transform(round2)
  .refine((value) => value > 0, { message: "Weight must be at least 0.01 lb" });
