import { Prisma } from "../../../generated/prisma/client.js";
import type { DecimalInput } from "../pricing/pricing.utils.js";

/** Courier earning per delivered shipment: 20% of the server-calculated price. */
export const COURIER_COMMISSION_RATE = "0.20";

/** Pure: earning for one delivery, as a 2-decimal string (half-up). */
export const calculateCourierEarning = (price: DecimalInput): string =>
  new Prisma.Decimal(price).times(COURIER_COMMISSION_RATE).toFixed(2, Prisma.Decimal.ROUND_HALF_UP);
