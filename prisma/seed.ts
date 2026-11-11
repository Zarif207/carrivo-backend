/**
 * Idempotent seed: safe to run any number of times.
 * - Zones and hubs are upserted by `code`.
 * - Users are created through Better Auth (so passwords are hashed by Better Auth),
 *   skipped if the email already exists, then their role/profile is (re)applied.
 * - Pricing rules are matched by their fixed `name` and updated or created.
 * - Sample shipments use fixed tracking ids (CRV-261101-SEEDxx); an existing one is
 *   left untouched (it may have been changed through the API since).
 * - Sample staff notifications (admin + viewer feed) use fixed "seed:" dedupe keys, so a
 *   re-run inserts nothing and never touches rows read or deleted since.
 * - Sample courier applications (PENDING, REJECTED, APPROVED) use fixed ids and are only
 *   inserted, never updated; they are skipped entirely when NODE_ENV=production.
 *
 * The demo password comes from SEED_DEMO_PASSWORD; it is never stored in code
 * and never printed. SEED_ADMIN_PASSWORD (optional) gives admin@carrivo.dev its own
 * password so the real admin does not share the public demo password.
 *
 * Production (NODE_ENV=production): SEED_CONFIRM_DB_HOST must name the target
 * host and the password must be strong (see seed.safety.ts and docs/DEPLOYMENT.md).
 * Existing accounts keep their password unless SEED_RESET_DEMO_PASSWORDS=true,
 * which re-hashes it through Better Auth, revokes their sessions and writes a
 * USER_PASSWORD_RESET_BY_SEED audit row per account.
 */
import { PLATFORM_CURRENCY } from "../src/app/config/currency.js";
import { env } from "../src/app/config/env.js";
import {
  CourierApplicationStatus,
  PaymentStatus,
  PickupStatus,
  Role,
  ServiceType,
  ShipmentPaymentStatus,
  ShipmentStatus,
  VehicleType,
  WorkAvailability,
} from "../src/generated/prisma/enums.js";
import { auth } from "../src/app/lib/auth.js";
import { prisma } from "../src/app/lib/prisma.js";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../src/app/modules/audit/audit.constants.js";
import { calculateCourierEarning } from "../src/app/modules/courier/courier.utils.js";
import { STAFF_RECIPIENT_WHERE, staffRows } from "../src/app/modules/notification/notification.staff.js";
import { buildStaffNotification, type StaffEvent, type StaffShipmentFacts } from "../src/app/modules/notification/notification.staff.utils.js";
import { calculatePrice } from "../src/app/modules/pricing/pricing.utils.js";
import { MAX_DELIVERY_ATTEMPTS, allowedTransitions } from "../src/app/modules/shipment/shipment.constants.js";
import { formatMoney } from "../src/app/utils/money.js";
import { adminPasswordProblems, checkSeedTarget, demoPasswordProblems } from "./seed.safety.js";
import { PRICING_RULES, ZONES } from "./seed.network.js";

interface SeedUser {
  name: string;
  email: string;
  role: Role;
  phone: string;
  courier?: { zoneCode: string; hubCode: string; vehicleType: VehicleType; vehicleNumber: string };
}

/* US demo users. Phone numbers use the fictional 555-0100 to 555-0199 range. Zones, hubs and
 * pricing rules live in seed.network.ts. */
const USERS: SeedUser[] = [
  { name: "Carrivo Admin", email: "admin@carrivo.dev", role: Role.ADMIN, phone: "(212) 555-0110" },
  { name: "Carrivo Viewer", email: "viewer@carrivo.dev", role: Role.ADMIN_VIEWER, phone: "(212) 555-0111" },
  {
    name: "Marcus Johnson",
    email: "courier1@carrivo.dev",
    role: Role.COURIER,
    phone: "(212) 555-0120",
    courier: { zoneCode: "NYC", hubCode: "HUB-NYC", vehicleType: VehicleType.VAN, vehicleNumber: "NY KDR-4821" },
  },
  {
    name: "Sofia Ramirez",
    email: "courier2@carrivo.dev",
    role: Role.COURIER,
    phone: "(213) 555-0121",
    courier: { zoneCode: "LA", hubCode: "HUB-LA", vehicleType: VehicleType.MOTORCYCLE, vehicleNumber: "CA 8MZK214" },
  },
  { name: "Emily Carter", email: "customer1@carrivo.dev", role: Role.CUSTOMER, phone: "(646) 555-0130" },
  { name: "David Kim", email: "customer2@carrivo.dev", role: Role.CUSTOMER, phone: "(310) 555-0131" },
];

/** Where each customer's parcels are picked up from (their sender address), by origin zone. */
const PICKUP_ADDRESS: Record<string, string> = {
  NYC: "120 W 45th St, New York, NY 10036",
  LA: "800 S Figueroa St, Los Angeles, CA 90017",
};

const seedZonesAndHubs = async (): Promise<Map<string, string>> => {
  const ids = new Map<string, string>();
  for (const zone of ZONES) {
    const savedZone = await prisma.zone.upsert({
      where: { code: zone.code },
      update: { name: zone.name, description: zone.description, deletedAt: null, isActive: true },
      create: { code: zone.code, name: zone.name, description: zone.description },
    });
    ids.set(zone.code, savedZone.id);

    for (const hub of zone.hubs) {
      const savedHub = await prisma.hub.upsert({
        where: { code: hub.code },
        update: { ...hub, zoneId: savedZone.id, deletedAt: null, isActive: true },
        create: { ...hub, zoneId: savedZone.id },
      });
      ids.set(hub.code, savedHub.id);
    }
  }
  return ids;
};

const requireId = (ids: Map<string, string>, code: string): string => {
  const id = ids.get(code);
  if (!id) throw new Error(`Seed: unknown zone/hub code ${code}`);
  return id;
};

const seedUser = async (
  user: SeedUser,
  password: string,
  ids: Map<string, string>,
): Promise<"created" | "existing"> => {
  const existing = await prisma.user.findUnique({ where: { email: user.email }, select: { id: true } });

  let userId: string;
  if (existing) {
    userId = existing.id;
  } else {
    const result = await auth.api.signUpEmail({
      body: { name: user.name, email: user.email, password, phone: user.phone },
    });
    userId = result.user.id;
    // Sign-up auto-signs-in; the seed doesn't need that session.
    await prisma.session.deleteMany({ where: { userId } });
  }

  // `role` is input:false in Better Auth, so it is set directly here.
  await prisma.user.update({
    where: { id: userId },
    data: { role: user.role, status: "ACTIVE", deletedAt: null, emailVerified: true },
  });

  if (user.courier) {
    const profile = {
      vehicleType: user.courier.vehicleType,
      vehicleNumber: user.courier.vehicleNumber,
      zoneId: requireId(ids, user.courier.zoneCode),
      hubId: requireId(ids, user.courier.hubCode),
      deletedAt: null,
    };
    await prisma.courierProfile.upsert({
      where: { userId },
      update: profile,
      create: { ...profile, userId, isAvailable: true },
    });
  }

  return existing ? "existing" : "created";
};

// ───────────── Pricing rules (USD, the platform currency) ─────────────
const seedPricingRules = async (ids: Map<string, string>): Promise<number> => {
  for (const rule of PRICING_RULES) {
    const data = {
      name: rule.name,
      serviceType: rule.serviceType,
      originZoneId: rule.route ? requireId(ids, rule.route[0]) : null,
      destinationZoneId: rule.route ? requireId(ids, rule.route[1]) : null,
      baseFee: rule.baseFee,
      baseWeightLb: rule.baseWeightLb,
      perLbFee: rule.perLbFee,
      maxWeightLb: rule.maxWeightLb,
      isActive: true,
      deletedAt: null,
    };
    const existing = await prisma.pricingRule.findFirst({ where: { name: rule.name }, select: { id: true } });
    if (existing) {
      await prisma.pricingRule.update({ where: { id: existing.id }, data });
    } else {
      await prisma.pricingRule.create({ data });
    }
  }
  return PRICING_RULES.length;
};

// ───────────── Sample shipments ─────────────
interface SeedShipment {
  trackingId: string;
  customer: string; // email
  courier?: string; // email
  from: "NYC" | "LA";
  to: "NYC" | "LA";
  serviceType: ServiceType;
  weightLb: number;
  status: ShipmentStatus;
  receiverName: string;
  receiverPhone: string;
  deliveryAddress: string;
  daysAgo: number;
  isFragile?: boolean;
  /** Override the default (PAID once past PENDING, UNPAID for PENDING/CANCELLED). */
  paid?: boolean;
  /** For FAILED_DELIVERY: how many failed attempts (default 1). */
  failedAttempts?: number;
}

const HAPPY_PATH: ShipmentStatus[] = [
  ShipmentStatus.PENDING,
  ShipmentStatus.PICKUP_SCHEDULED,
  ShipmentStatus.COURIER_ASSIGNED,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.AT_ORIGIN_HUB,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.AT_DESTINATION_HUB,
  ShipmentStatus.OUT_FOR_DELIVERY,
];

/** The statuses a shipment went through to reach `status`, checked against the state machine. */
const pathTo = (status: ShipmentStatus, failedAttempts = 1): ShipmentStatus[] => {
  let path: ShipmentStatus[];
  if (status === ShipmentStatus.CANCELLED) path = [ShipmentStatus.PENDING, ShipmentStatus.CANCELLED];
  else if (status === ShipmentStatus.DELIVERED) path = [...HAPPY_PATH, status];
  else if (status === ShipmentStatus.FAILED_DELIVERY) {
    // OUT_FOR_DELIVERY → FAILED_DELIVERY, then (retry → fail) for each extra attempt.
    path = [...HAPPY_PATH, status];
    for (let i = 1; i < failedAttempts; i += 1) path.push(ShipmentStatus.OUT_FOR_DELIVERY, ShipmentStatus.FAILED_DELIVERY);
  } else path = HAPPY_PATH.slice(0, HAPPY_PATH.indexOf(status) + 1);
  for (let i = 1; i < path.length; i += 1) {
    const prev = path[i - 1];
    const next = path[i];
    if (!prev || !next || !allowedTransitions[prev].includes(next)) {
      throw new Error(`Seed: invalid status path ${path.join(" -> ")}`);
    }
  }
  return path;
};

const SHIPMENTS: SeedShipment[] = [
  { trackingId: "CRV-261101-SEED01", customer: "customer1@carrivo.dev", from: "NYC", to: "LA", serviceType: ServiceType.STANDARD, weightLb: 5.1, status: ShipmentStatus.PENDING, receiverName: "Olivia Martinez", receiverPhone: "(323) 555-0140", deliveryAddress: "1520 N Vine St, Los Angeles, CA 90028", daysAgo: 0 },
  { trackingId: "CRV-261101-SEED02", customer: "customer1@carrivo.dev", from: "NYC", to: "NYC", serviceType: ServiceType.EXPRESS, weightLb: 2.2, status: ShipmentStatus.PICKUP_SCHEDULED, receiverName: "James Wilson", receiverPhone: "(718) 555-0141", deliveryAddress: "245 Bedford Ave, Brooklyn, NY 11211", daysAgo: 1 },
  { trackingId: "CRV-261101-SEED03", customer: "customer2@carrivo.dev", courier: "courier2@carrivo.dev", from: "LA", to: "LA", serviceType: ServiceType.STANDARD, weightLb: 7.7, status: ShipmentStatus.COURIER_ASSIGNED, receiverName: "Ava Thompson", receiverPhone: "(310) 555-0142", deliveryAddress: "1310 3rd St, Santa Monica, CA 90401", daysAgo: 2 },
  { trackingId: "CRV-261101-SEED04", customer: "customer1@carrivo.dev", courier: "courier1@carrivo.dev", from: "NYC", to: "LA", serviceType: ServiceType.STANDARD, weightLb: 8.8, status: ShipmentStatus.PICKED_UP, receiverName: "Noah Brown", receiverPhone: "(626) 555-0143", deliveryAddress: "75 W Colorado Blvd, Pasadena, CA 91105", daysAgo: 3, isFragile: true },
  { trackingId: "CRV-261101-SEED05", customer: "customer2@carrivo.dev", courier: "courier2@carrivo.dev", from: "LA", to: "NYC", serviceType: ServiceType.EXPRESS, weightLb: 4, status: ShipmentStatus.IN_TRANSIT, receiverName: "Mia Davis", receiverPhone: "(917) 555-0144", deliveryAddress: "88 Greenwich St, New York, NY 10006", daysAgo: 4 },
  { trackingId: "CRV-261101-SEED06", customer: "customer1@carrivo.dev", courier: "courier1@carrivo.dev", from: "NYC", to: "NYC", serviceType: ServiceType.SAME_DAY, weightLb: 1.8, status: ShipmentStatus.OUT_FOR_DELIVERY, receiverName: "Ethan Garcia", receiverPhone: "(347) 555-0145", deliveryAddress: "31-15 Steinway St, Astoria, NY 11103", daysAgo: 5 },
  { trackingId: "CRV-261101-SEED07", customer: "customer2@carrivo.dev", courier: "courier2@carrivo.dev", from: "LA", to: "LA", serviceType: ServiceType.STANDARD, weightLb: 11, status: ShipmentStatus.DELIVERED, receiverName: "Isabella Lee", receiverPhone: "(562) 555-0146", deliveryAddress: "400 Pine Ave, Long Beach, CA 90802", daysAgo: 8 },
  { trackingId: "CRV-261101-SEED08", customer: "customer1@carrivo.dev", courier: "courier1@carrivo.dev", from: "NYC", to: "LA", serviceType: ServiceType.EXPRESS, weightLb: 4.4, status: ShipmentStatus.FAILED_DELIVERY, receiverName: "Liam Anderson", receiverPhone: "(213) 555-0147", deliveryAddress: "600 W 9th St, Los Angeles, CA 90015", daysAgo: 10 },
  { trackingId: "CRV-261101-SEED09", customer: "customer2@carrivo.dev", from: "LA", to: "NYC", serviceType: ServiceType.STANDARD, weightLb: 2.6, status: ShipmentStatus.CANCELLED, receiverName: "Charlotte Moore", receiverPhone: "(201) 555-0148", deliveryAddress: "30 Montgomery St, Jersey City, NJ 07302", daysAgo: 12 },
  // Workflow demos: PENDING but PAID (ready for POST /pickup), unassigned
  // PICKUP_SCHEDULED (ready for POST /assign), and 3 failed attempts (only RETURNED left).
  { trackingId: "CRV-261101-SEED10", customer: "customer1@carrivo.dev", from: "NYC", to: "NYC", serviceType: ServiceType.STANDARD, weightLb: 3.3, status: ShipmentStatus.PENDING, paid: true, receiverName: "Benjamin Clark", receiverPhone: "(646) 555-0149", deliveryAddress: "410 E 61st St, New York, NY 10065", daysAgo: 0 },
  { trackingId: "CRV-261101-SEED11", customer: "customer2@carrivo.dev", from: "LA", to: "LA", serviceType: ServiceType.STANDARD, weightLb: 5.5, status: ShipmentStatus.PICKUP_SCHEDULED, receiverName: "Amelia Lewis", receiverPhone: "(818) 555-0150", deliveryAddress: "100 N Brand Blvd, Glendale, CA 91203", daysAgo: 1 },
  { trackingId: "CRV-261101-SEED12", customer: "customer2@carrivo.dev", courier: "courier2@carrivo.dev", from: "LA", to: "LA", serviceType: ServiceType.STANDARD, weightLb: 2.2, status: ShipmentStatus.FAILED_DELIVERY, failedAttempts: 3, receiverName: "Lucas Walker", receiverPhone: "(424) 555-0151", deliveryAddress: "1000 Abbot Kinney Blvd, Venice, CA 90291", daysAgo: 6 },
];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Who would have made each change: customer creates/cancels, admin schedules/assigns, courier moves it. */
const changedByFor = (status: ShipmentStatus, users: { customer: string; admin: string; courier?: string }): string => {
  if (status === ShipmentStatus.PENDING || status === ShipmentStatus.CANCELLED) return users.customer;
  if (status === ShipmentStatus.PICKUP_SCHEDULED || status === ShipmentStatus.COURIER_ASSIGNED) return users.admin;
  return users.courier ?? users.admin;
};

const seedShipments = async (ids: Map<string, string>, userIds: Map<string, string>): Promise<{ created: number; existing: number }> => {
  const adminId = userIds.get("admin@carrivo.dev");
  if (!adminId) throw new Error("Seed: admin user missing");
  let created = 0;
  let existing = 0;

  for (const s of SHIPMENTS) {
    const found = await prisma.shipment.findUnique({ where: { trackingId: s.trackingId }, select: { id: true } });
    if (found) {
      existing += 1;
      continue;
    }

    const customerId = userIds.get(s.customer);
    const courierId = s.courier ? userIds.get(s.courier) : undefined;
    if (!customerId || (s.courier && !courierId)) throw new Error(`Seed: unknown user for ${s.trackingId}`);
    const customer = USERS.find((u) => u.email === s.customer);

    const originZoneId = requireId(ids, s.from);
    const destinationZoneId = requireId(ids, s.to);
    const originHubId = requireId(ids, `HUB-${s.from}`);
    const destinationHubId = requireId(ids, `HUB-${s.to}`);

    // Price with the same rule lookup + pure function the API uses.
    const rule =
      (await prisma.pricingRule.findFirst({
        where: { serviceType: s.serviceType, originZoneId, destinationZoneId, isActive: true, deletedAt: null },
      })) ??
      (await prisma.pricingRule.findFirst({
        where: { serviceType: s.serviceType, originZoneId: null, destinationZoneId: null, isActive: true, deletedAt: null },
      }));
    if (!rule) throw new Error(`Seed: no pricing rule for ${s.trackingId}`);
    const priced = calculatePrice(rule, s.weightLb);
    if (!priced.ok) throw new Error(`Seed: cannot price ${s.trackingId}: ${priced.reason}`);

    const path = pathTo(s.status, s.failedAttempts);
    const createdAt = new Date(Date.now() - s.daysAgo * DAY - path.length * 2 * HOUR);
    const at = (step: number): Date => new Date(createdAt.getTime() + step * 2 * HOUR);
    const reached = (status: ShipmentStatus): number => path.indexOf(status);
    const paid = s.paid ?? (s.status !== ShipmentStatus.PENDING && s.status !== ShipmentStatus.CANCELLED);

    await prisma.$transaction(async (tx) => {
      const shipment = await tx.shipment.create({
        data: {
          trackingId: s.trackingId,
          customerId,
          courierId: courierId ?? null,
          senderName: customer?.name ?? "Customer",
          senderPhone: customer?.phone ?? "(212) 555-0199",
          pickupAddress: PICKUP_ADDRESS[s.from] ?? "120 W 45th St, New York, NY 10036",
          receiverName: s.receiverName,
          receiverPhone: s.receiverPhone,
          deliveryAddress: s.deliveryAddress,
          originZoneId,
          destinationZoneId,
          originHubId,
          destinationHubId,
          currentHubId:
            s.status === ShipmentStatus.AT_ORIGIN_HUB ? originHubId : s.status === ShipmentStatus.AT_DESTINATION_HUB ? destinationHubId : null,
          weightLb: s.weightLb,
          description: "Sample parcel (seed data)",
          isFragile: s.isFragile ?? false,
          serviceType: s.serviceType,
          price: priced.breakdown.total,
          currency: PLATFORM_CURRENCY,
          priceBreakdown: {
            ...priced.breakdown,
            serviceType: s.serviceType,
            ruleId: rule.id,
            ruleName: rule.name,
            calculatedAt: createdAt.toISOString(),
          },
          status: s.status,
          // Seeded without Payment rows; Phase 6 adds real payments.
          paymentStatus: paid ? ShipmentPaymentStatus.PAID : ShipmentPaymentStatus.UNPAID,
          failedAttempts: s.status === ShipmentStatus.FAILED_DELIVERY ? (s.failedAttempts ?? 1) : 0,
          failureReason: s.status === ShipmentStatus.FAILED_DELIVERY ? "Receiver unavailable" : null,
          cancelReason: s.status === ShipmentStatus.CANCELLED ? "Changed my mind" : null,
          pickedUpAt: reached(ShipmentStatus.PICKED_UP) >= 0 ? at(reached(ShipmentStatus.PICKED_UP)) : null,
          deliveredAt: s.status === ShipmentStatus.DELIVERED ? at(path.length - 1) : null,
          cancelledAt: s.status === ShipmentStatus.CANCELLED ? at(path.length - 1) : null,
          createdAt,
          updatedAt: at(path.length - 1),
        },
        select: { id: true },
      });

      await tx.shipmentStatusHistory.createMany({
        data: path.map((status, step) => ({
          shipmentId: shipment.id,
          fromStatus: step === 0 ? null : (path[step - 1] ?? null),
          toStatus: status,
          note: step === 0 ? "Shipment created" : status === ShipmentStatus.FAILED_DELIVERY ? "Receiver unavailable" : null,
          hubId:
            status === ShipmentStatus.PENDING || status === ShipmentStatus.AT_ORIGIN_HUB
              ? originHubId
              : status === ShipmentStatus.AT_DESTINATION_HUB
                ? destinationHubId
                : null,
          changedById: changedByFor(status, { customer: customerId, admin: adminId, ...(courierId ? { courier: courierId } : {}) }),
          createdAt: at(step),
        })),
      });

      await tx.auditLog.create({
        data: {
          actorId: customerId,
          actorRole: Role.CUSTOMER,
          action: AUDIT_ACTIONS.SHIPMENT_CREATED,
          entityType: AUDIT_ENTITIES.SHIPMENT,
          entityId: shipment.id,
          after: { trackingId: s.trackingId, status: ShipmentStatus.PENDING, price: priced.breakdown.total, source: "seed" },
          createdAt,
        },
      });
    });
    created += 1;
  }
  return { created, existing };
};

/**
 * Pickup requests and courier earnings for the sample shipments, created only if
 * missing (so this also backfills databases seeded before Phase 4).
 */
const seedWorkflowExtras = async (): Promise<{ pickups: number; earnings: number }> => {
  let pickups = 0;
  let earnings = 0;
  const rows = await prisma.shipment.findMany({
    where: { trackingId: { in: SHIPMENTS.map((s) => s.trackingId) }, deletedAt: null },
    select: {
      id: true,
      status: true,
      price: true,
      courierId: true,
      customerId: true,
      createdAt: true,
      pickedUpAt: true,
      deliveredAt: true,
      pickupAddress: true,
      senderName: true,
      senderPhone: true,
      pickupRequest: { select: { id: true } },
      earning: { select: { id: true } },
    },
  });
  for (const row of rows) {
    const scheduled = row.status !== ShipmentStatus.PENDING && row.status !== ShipmentStatus.CANCELLED;
    if (scheduled && !row.pickupRequest) {
      const start = new Date(row.createdAt.getTime() + 6 * HOUR);
      await prisma.pickupRequest.create({
        data: {
          shipmentId: row.id,
          requestedById: row.customerId,
          pickupAddress: row.pickupAddress,
          contactName: row.senderName,
          contactPhone: row.senderPhone,
          scheduledAt: start,
          scheduledUntil: new Date(start.getTime() + 2 * HOUR),
          status: row.pickedUpAt ? PickupStatus.COMPLETED : PickupStatus.SCHEDULED,
          completedAt: row.pickedUpAt,
        },
      });
      pickups += 1;
    }
    if (row.status === ShipmentStatus.DELIVERED && row.courierId && !row.earning) {
      await prisma.courierEarning.create({
        data: {
          courierId: row.courierId,
          shipmentId: row.id,
          amount: calculateCourierEarning(row.price),
          createdAt: row.deliveredAt ?? new Date(),
        },
      });
      earnings += 1;
    }
  }
  return { pickups, earnings };
};

/** Same rule lookup the API uses: exact route rule, else the service's default rule. */
const findRule = (serviceType: ServiceType, originZoneId: string, destinationZoneId: string) =>
  prisma.pricingRule
    .findFirst({ where: { serviceType, originZoneId, destinationZoneId, isActive: true, deletedAt: null } })
    .then(
      (exact) =>
        exact ??
        prisma.pricingRule.findFirst({
          where: { serviceType, originZoneId: null, destinationZoneId: null, isActive: true, deletedAt: null },
        }),
    );

/**
 * Brings already-seeded sample shipments (matched by their fixed tracking ids) to
 * the current rate card and currency, using the same pure calculatePrice as the
 * API, then aligns their SEED payments and courier earnings (20% of the new price).
 * Only seed data is touched: real (STRIPE) payments are never modified.
 */
const syncSeedMoney = async (): Promise<{ repriced: number; payments: number; earnings: number }> => {
  let repriced = 0;
  let payments = 0;
  let earnings = 0;
  const rows = await prisma.shipment.findMany({
    where: { trackingId: { in: SHIPMENTS.map((s) => s.trackingId) } },
    select: {
      id: true,
      trackingId: true,
      customerId: true,
      serviceType: true,
      weightLb: true,
      originZoneId: true,
      destinationZoneId: true,
      price: true,
      currency: true,
      paymentStatus: true,
      createdAt: true,
      earning: { select: { id: true, amount: true } },
      payments: { select: { id: true, provider: true, status: true, amount: true } },
    },
  });
  for (const row of rows) {
    const rule = await findRule(row.serviceType, row.originZoneId, row.destinationZoneId);
    if (!rule) throw new Error(`Seed: no pricing rule for ${row.trackingId}`);
    const priced = calculatePrice(rule, row.weightLb);
    if (!priced.ok) throw new Error(`Seed: cannot price ${row.trackingId}: ${priced.reason}`);
    const price = priced.breakdown.total;

    if (row.price.toFixed(2) !== price || row.currency !== PLATFORM_CURRENCY) {
      await prisma.shipment.update({
        where: { id: row.id },
        data: {
          price,
          currency: PLATFORM_CURRENCY,
          priceBreakdown: {
            ...priced.breakdown,
            serviceType: row.serviceType,
            ruleId: rule.id,
            ruleName: rule.name,
            calculatedAt: new Date().toISOString(),
          },
        },
      });
      repriced += 1;
    }

    // One SEED payment for each paid sample shipment (no Stripe ids: clearly seed data).
    const seedPayment = row.payments.find((p) => p.provider === "SEED");
    const realPayment = row.payments.find((p) => p.provider !== "SEED" && p.status !== PaymentStatus.EXPIRED && p.status !== PaymentStatus.FAILED);
    if (seedPayment) {
      if (seedPayment.amount.toFixed(2) !== price) {
        await prisma.payment.update({
          where: { id: seedPayment.id },
          data: { amount: price, paidAmount: price, currency: PLATFORM_CURRENCY, paidCurrency: PLATFORM_CURRENCY },
        });
        payments += 1;
      }
    } else if (row.paymentStatus === "PAID" && !realPayment) {
      await prisma.payment.create({
        data: {
          shipmentId: row.id,
          userId: row.customerId,
          amount: price,
          paidAmount: price,
          currency: PLATFORM_CURRENCY,
          paidCurrency: PLATFORM_CURRENCY,
          status: PaymentStatus.PAID,
          provider: "SEED",
          paidAt: new Date(row.createdAt.getTime() + HOUR),
          createdAt: row.createdAt,
        },
      });
      payments += 1;
    }

    if (row.earning) {
      const amount = calculateCourierEarning(price);
      if (row.earning.amount.toFixed(2) !== amount) {
        await prisma.courierEarning.update({ where: { id: row.earning.id }, data: { amount } });
        earnings += 1;
      }
    }
  }
  return { repriced, payments, earnings };
};

/**
 * Sets a demo account's password to SEED_DEMO_PASSWORD (Better Auth's hasher, the
 * same as sign-up), revokes its sessions and audits it. Returns false when the
 * account has no email/password credential (e.g. Google-only).
 */
/**
 * A few staff notifications so the admin and viewer feeds aren't empty in the demo: built
 * with the same builder as the live events, from the sample shipments above. Additive and
 * re-runnable: each row has a fixed "seed:<slug>:<userId>" key under the unique index.
 */
const seedStaffNotifications = async (): Promise<{ created: number; skipped: number }> => {
  const recipients = await prisma.user.findMany({ where: STAFF_RECIPIENT_WHERE, select: { id: true } });
  const shipments = await prisma.shipment.findMany({
    where: { trackingId: { in: ["CRV-261101-SEED01", "CRV-261101-SEED07", "CRV-261101-SEED09", "CRV-261101-SEED10", "CRV-261101-SEED12"] } },
    select: {
      id: true,
      trackingId: true,
      serviceType: true,
      price: true,
      currency: true,
      failureReason: true,
      failedAttempts: true,
      cancelReason: true,
      customer: { select: { name: true } },
      courier: { select: { name: true } },
      originZone: { select: { name: true } },
      destinationZone: { select: { name: true } },
      payments: { where: { status: PaymentStatus.PAID }, select: { id: true, amount: true, paidAmount: true, currency: true }, take: 1 },
    },
  });
  const byTracking = new Map(shipments.map((s) => [s.trackingId, s]));
  const facts = (trackingId: string): StaffShipmentFacts | null => {
    const s = byTracking.get(trackingId);
    if (!s) return null;
    const route = s.originZone.name === s.destinationZone.name ? `within ${s.originZone.name}` : `${s.originZone.name} to ${s.destinationZone.name}`;
    return { id: s.id, trackingId: s.trackingId, route, customerName: s.customer.name };
  };
  const courier = await prisma.user.findUnique({
    where: { email: "courier2@carrivo.dev" },
    select: { id: true, name: true, email: true, courierProfile: { select: { zone: { select: { name: true } } } } },
  });
  const hub = await prisma.hub.findUnique({ where: { code: "HUB-ATL-AP" }, select: { id: true, code: true, name: true, city: true } });

  // [slug, hours ago, read?, event]; a missing sample (renamed or deleted) just drops its row.
  const samples: [string, number, boolean, StaffEvent | null][] = [];
  const created = facts("CRV-261101-SEED01");
  const s01 = byTracking.get("CRV-261101-SEED01");
  if (created && s01) {
    samples.push(["shipment-created-seed01", 1, false, { kind: "SHIPMENT_CREATED", shipment: created, serviceType: s01.serviceType, amount: formatMoney(s01.price), currency: s01.currency }]);
  }
  const s10 = byTracking.get("CRV-261101-SEED10");
  const paid = s10?.payments[0];
  if (s10 && paid) {
    samples.push(["payment-received-seed10", 2, false, {
      kind: "PAYMENT_RECEIVED",
      payment: { paymentId: paid.id, shipment: { id: s10.id, trackingId: s10.trackingId }, amount: formatMoney(paid.paidAmount ?? paid.amount), currency: paid.currency },
    }]);
  }
  const failed = facts("CRV-261101-SEED12");
  const s12 = byTracking.get("CRV-261101-SEED12");
  if (failed && s12) {
    samples.push(["failed-delivery-seed12", 5, false, {
      kind: "FAILED_DELIVERY",
      shipment: failed,
      reason: s12.failureReason ?? "Recipient not available",
      attempt: Math.max(s12.failedAttempts, 1),
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
    }]);
  }
  const cancelled = facts("CRV-261101-SEED09");
  if (cancelled) {
    samples.push(["shipment-cancelled-seed09", 26, false, {
      kind: "SHIPMENT_CANCELLED",
      shipment: cancelled,
      reason: byTracking.get("CRV-261101-SEED09")?.cancelReason ?? "Customer changed plans",
      refundPending: false,
    }]);
  }
  const delivered = facts("CRV-261101-SEED07");
  if (delivered) {
    samples.push(["delivered-seed07", 50, true, { kind: "DELIVERED", shipment: delivered, courierName: byTracking.get("CRV-261101-SEED07")?.courier?.name ?? null }]);
  }
  if (courier) {
    samples.push(["courier-added-courier2", 6 * 24, true, {
      kind: "COURIER_ADDED",
      user: { id: courier.id, name: courier.name, email: courier.email },
      zoneName: courier.courierProfile?.zone.name ?? null,
      via: "created",
      actorName: "Carrivo Admin",
    }]);
  }
  if (hub) {
    samples.push(["hub-created-atl-ap", 7 * 24, true, { kind: "HUB_CHANGED", action: "created", hub, actorName: "Carrivo Admin" }]);
  }

  const now = Date.now();
  const data = samples.flatMap(([slug, hoursAgo, read, event]) => {
    if (!event) return [];
    const content = { ...buildStaffNotification(event), dedupeKey: `seed:${slug}` };
    const at = new Date(now - hoursAgo * HOUR);
    return staffRows(content, recipients.map((r) => r.id)).map((row) => ({ ...row, createdAt: at, readAt: read ? at : null }));
  });
  if (data.length === 0) return { created: 0, skipped: 0 };
  const { count } = await prisma.notification.createMany({ data, skipDuplicates: true });
  return { created: count, skipped: data.length - count };
};

/**
 * Dev/demo courier applications, one per decision state, on the seeded accounts:
 * - customer2: PENDING (the admin queue has something to review),
 * - customer1: REJECTED 12 days ago (past the 7-day wait, so the demo customer can apply again),
 * - courier2: APPROVED 30 days ago (how that courier joined).
 * Fixed ids + createMany(skipDuplicates): a re-run inserts nothing and never rewrites a row an
 * admin has decided since; a user with a pending application of their own keeps it (the
 * one-pending index makes the sample skip). Never runs in production.
 */
const SEED_APPLICATIONS = [
  {
    id: "019a5e00-0000-7000-8000-00000000a001",
    email: "customer2@carrivo.dev",
    status: CourierApplicationStatus.PENDING,
    daysAgo: 1,
    phone: "(310) 555-0131",
    zoneCode: "LA",
    vehicleType: VehicleType.CAR,
    vehiclePlate: "CA 7XYZ318",
    availability: WorkAvailability.WEEKENDS,
    experience: "Two years of weekend food delivery around Santa Monica and Venice.",
    about: "I know the Westside well and want steady weekend routes.",
    reviewNote: null,
  },
  {
    id: "019a5e00-0000-7000-8000-00000000a002",
    email: "customer1@carrivo.dev",
    status: CourierApplicationStatus.REJECTED,
    daysAgo: 14,
    reviewedDaysAgo: 12,
    phone: "(646) 555-0130",
    zoneCode: "NYC",
    vehicleType: VehicleType.BICYCLE,
    vehiclePlate: null,
    availability: WorkAvailability.WEEKDAYS,
    experience: null,
    about: "Looking for part-time work in Midtown.",
    reviewNote: "Manhattan routes need a cargo bike or motor vehicle for our parcel sizes. You are welcome to apply again with one.",
  },
  {
    id: "019a5e00-0000-7000-8000-00000000a003",
    email: "courier2@carrivo.dev",
    status: CourierApplicationStatus.APPROVED,
    daysAgo: 31,
    reviewedDaysAgo: 30,
    phone: "(213) 555-0121",
    zoneCode: "LA",
    vehicleType: VehicleType.MOTORCYCLE,
    vehiclePlate: "CA 8MZK214",
    availability: WorkAvailability.FULL_TIME,
    experience: "Five years as a motorcycle courier in downtown Los Angeles.",
    about: null,
    reviewNote: null,
  },
] as const;

const seedCourierApplications = async (ids: Map<string, string>): Promise<{ created: number; skipped: number }> => {
  const users = await prisma.user.findMany({
    where: { email: { in: [...SEED_APPLICATIONS.map((a) => a.email), "admin@carrivo.dev"] } },
    select: { id: true, email: true },
  });
  const idOf = new Map(users.map((u) => [u.email, u.id]));
  const adminId = idOf.get("admin@carrivo.dev") ?? null;
  const now = Date.now();
  const data = SEED_APPLICATIONS.flatMap((a) => {
    const userId = idOf.get(a.email);
    if (!userId) return [];
    const decided = a.status !== CourierApplicationStatus.PENDING;
    if (decided && !adminId) return [];
    const createdAt = new Date(now - a.daysAgo * DAY);
    const reviewedAt = "reviewedDaysAgo" in a ? new Date(now - a.reviewedDaysAgo * DAY) : null;
    return [
      {
        id: a.id,
        userId,
        status: a.status,
        phone: a.phone,
        preferredZoneId: requireId(ids, a.zoneCode),
        vehicleType: a.vehicleType,
        vehiclePlate: a.vehiclePlate,
        availability: a.availability,
        experience: a.experience,
        about: a.about,
        reviewedById: decided ? adminId : null,
        reviewedAt: decided ? reviewedAt : null,
        reviewNote: a.reviewNote,
        createdAt,
        updatedAt: reviewedAt ?? createdAt,
      },
    ];
  });
  if (data.length === 0) return { created: 0, skipped: 0 };
  const { count } = await prisma.courierApplication.createMany({ data, skipDuplicates: true });
  return { created: count, skipped: data.length - count };
};

const resetDemoPassword = async (userId: string, email: string, password: string): Promise<boolean> => {
  const ctx = await auth.$context;
  if (!(await ctx.internalAdapter.findCredentialAccount(userId))) return false;
  const hash = await ctx.password.hash(password);
  await ctx.internalAdapter.updatePassword(userId, hash);
  await prisma.$transaction([
    prisma.session.deleteMany({ where: { userId } }),
    prisma.auditLog.create({
      data: {
        actorId: null,
        actorRole: null,
        action: AUDIT_ACTIONS.USER_PASSWORD_RESET_BY_SEED,
        entityType: AUDIT_ENTITIES.USER,
        entityId: userId,
        // Never the password or its hash.
        after: { email, sessionsRevoked: true, source: "prisma/seed.ts" },
      },
    }),
  ]);
  return true;
};

async function main(): Promise<void> {
  const production = env.NODE_ENV === "production";

  // Both checks run before the first query, so a refused seed writes nothing.
  const target = checkSeedTarget({
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    confirmHost: process.env["SEED_CONFIRM_DB_HOST"],
  });
  if (!target.ok) throw new Error(`Seed refused: ${target.reason}`);

  const password = env.SEED_DEMO_PASSWORD;
  const problems = demoPasswordProblems(password, production);
  if (!password || problems.length > 0) {
    throw new Error(
      `Seed refused: SEED_DEMO_PASSWORD is not acceptable${production ? " for production" : ""}: ${problems.join(" ")}`,
    );
  }
  const adminProblems = adminPasswordProblems(env.SEED_ADMIN_PASSWORD, password, production);
  if (adminProblems.length > 0) {
    throw new Error(`Seed refused: SEED_ADMIN_PASSWORD is not acceptable${production ? " for production" : ""}: ${adminProblems.join(" ")}`);
  }
  const passwordFor = (user: SeedUser): string => (user.role === Role.ADMIN && env.SEED_ADMIN_PASSWORD) || password;
  const resetPasswords = process.env["SEED_RESET_DEMO_PASSWORDS"] === "true";
  console.log(`Seed: target database host ${target.host}${production ? " (production)" : ""}.`);

  const ids = await seedZonesAndHubs();
  console.log(`Seed: ${ZONES.length} zones and ${ZONES.reduce((n, z) => n + z.hubs.length, 0)} hubs upserted.`);

  const rules = await seedPricingRules(ids);
  console.log(`Seed: ${rules} pricing rules upserted.`);

  const rows: { role: string; email: string; status: string }[] = [];
  const reset: string[] = [];
  for (const user of USERS) {
    const status = await seedUser(user, passwordFor(user), ids);
    let shown: string = status;
    if (status === "existing" && resetPasswords) {
      const found = await prisma.user.findUniqueOrThrow({ where: { email: user.email }, select: { id: true } });
      if (await resetDemoPassword(found.id, user.email, passwordFor(user))) {
        reset.push(user.email);
        shown = "existing (password reset)";
      }
    }
    rows.push({ role: user.role, email: user.email, status: shown });
  }

  const users = await prisma.user.findMany({
    where: { email: { in: USERS.map((u) => u.email) } },
    select: { id: true, email: true },
  });
  const shipments = await seedShipments(ids, new Map(users.map((u) => [u.email, u.id])));
  console.log(`Seed: sample shipments ${shipments.created} created, ${shipments.existing} already present.`);
  const extras = await seedWorkflowExtras();
  console.log(`Seed: ${extras.pickups} pickup request(s) and ${extras.earnings} courier earning(s) added.`);
  const money = await syncSeedMoney();
  console.log(
    `Seed: ${money.repriced} sample shipment(s) re-priced in ${PLATFORM_CURRENCY}, ${money.payments} seed payment(s) and ${money.earnings} earning(s) aligned.`,
  );
  const notices = await seedStaffNotifications();
  console.log(`Seed: staff notifications ${notices.created} created, ${notices.skipped} already present.`);
  if (production) {
    console.log("Seed: sample courier applications skipped (production).");
  } else {
    const applications = await seedCourierApplications(ids);
    console.log(`Seed: sample courier applications ${applications.created} created, ${applications.skipped} already present.`);
  }

  console.log(
    `\nDemo accounts (password from SEED_DEMO_PASSWORD${env.SEED_ADMIN_PASSWORD ? "; the admin uses SEED_ADMIN_PASSWORD" : ""}; never printed):`,
  );
  console.table(rows);
  if (reset.length > 0) {
    console.log(`Passwords reset (sessions revoked, audited) for: ${reset.join(", ")}`);
  } else if (rows.some((row) => row.status === "existing")) {
    console.log("Existing accounts kept their current password. Set SEED_RESET_DEMO_PASSWORDS=true to rotate them.");
  }
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
