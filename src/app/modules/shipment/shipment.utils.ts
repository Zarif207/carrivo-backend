import { randomBytes } from "node:crypto";
import httpStatus from "http-status";
import { isUniqueViolationOn } from "../../errors/handlePrismaError.js";
import { ApiError } from "../../utils/ApiError.js";
import { BUSINESS_TIMEZONE, TRACKING_ID_MAX_ATTEMPTS, TRACKING_ID_PREFIX } from "./shipment.constants.js";

/** 32 symbols, no look-alikes (0/O, 1/I). 32 divides 256, so `byte & 31` has no modulo bias. */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const SUFFIX_LENGTH = 6;

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TIMEZONE,
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
});

/** YYMMDD in the business timezone (Asia/Dhaka). */
export const formatTrackingDate = (date: Date): string => {
  const parts = dateFormatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
};

/** CRV-YYMMDD-XXXXXX, e.g. CRV-261106-K7Q2ZP. `random` is injectable for tests. */
export const generateTrackingId = (
  now: Date = new Date(),
  random: (size: number) => Uint8Array = randomBytes,
): string => {
  const bytes = random(SUFFIX_LENGTH);
  let suffix = "";
  for (const byte of bytes) suffix += ALPHABET[byte & 31];
  return `${TRACKING_ID_PREFIX}-${formatTrackingDate(now)}-${suffix}`;
};

/**
 * Runs `attempt(trackingId)` with a fresh tracking id, retrying ONLY when the
 * failure is a unique violation on `trackingId`. Any other error (including a
 * P2002 on another field) is rethrown at once and maps to its normal response.
 */
export const withTrackingIdRetry = async <T>(
  attempt: (trackingId: string) => Promise<T>,
  generate: () => string = generateTrackingId,
  maxAttempts: number = TRACKING_ID_MAX_ATTEMPTS,
): Promise<T> => {
  for (let i = 1; i <= maxAttempts; i += 1) {
    try {
      return await attempt(generate());
    } catch (error) {
      if (!isUniqueViolationOn(error, "trackingId")) throw error;
    }
  }
  throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, "Could not allocate a tracking ID, please try again");
};
