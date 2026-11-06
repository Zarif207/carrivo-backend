import type { Prisma } from "../../../generated/prisma/client.js";
import type { PaymentStatus, ShipmentStatus } from "../../../generated/prisma/enums.js";
import type { PlatformCurrency } from "../../config/currency.js";
import { courierProfileSelect, type CourierProfileDto } from "../courier/courier.types.js";
import { safeUserSelect, type SafeUser } from "../user/user.types.js";

/** Safe user columns plus the courier profile (soft-deleted profiles are shown as null). */
export const adminUserSelect = {
  ...safeUserSelect,
  courierProfile: { select: { ...courierProfileSelect, deletedAt: true } },
} as const satisfies Prisma.UserSelect;

export type AdminUserRow = Prisma.UserGetPayload<{ select: typeof adminUserSelect }>;

export type AdminUser = SafeUser & { courierProfile: CourierProfileDto | null };

export interface DashboardStats {
  shipments: { total: number; byStatus: Record<ShipmentStatus, number> };
  /** From Payment rows: collected (PAID + REFUND_PENDING + REFUNDED) minus REFUNDED. */
  revenue: { currency: PlatformCurrency; grossCollected: string; refunded: string; net: string };
  paymentsByStatus: Record<PaymentStatus, number>;
  shipmentsPerDay: { date: string; count: number }[];
  topCouriers: { id: string; name: string; deliveries: number }[];
  failedDeliveryRate: { rate: number; failedAttempts: number; deliveredShipments: number };
  counts: { activeCouriers: number; activeCustomers: number; activeHubs: number };
  generatedAt: string;
}
