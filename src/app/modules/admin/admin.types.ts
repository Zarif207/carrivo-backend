import type { Prisma } from "../../../generated/prisma/client.js";
import type { ShipmentStatus } from "../../../generated/prisma/enums.js";
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
  revenue: { currency: "bdt"; paidTotal: string; source: string };
  shipmentsPerDay: { date: string; count: number }[];
  topCouriers: { id: string; name: string; deliveries: number }[];
  failedDeliveryRate: { rate: number; failedAttempts: number; deliveredShipments: number };
  counts: { activeCouriers: number; activeCustomers: number; activeHubs: number };
  generatedAt: string;
}
