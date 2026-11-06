/**
 * Idempotent seed: safe to run any number of times.
 * - Zones and hubs are upserted by `code`.
 * - Users are created through Better Auth (so passwords are hashed by Better Auth),
 *   skipped if the email already exists, then their role/profile is (re)applied.
 * - Pricing rules are matched by their fixed `name` and updated or created.
 * - Sample shipments use fixed tracking ids (CRV-261101-SEEDxx); an existing one is
 *   left untouched (it may have been changed through the API since).
 *
 * The demo password comes from SEED_DEMO_PASSWORD; it is never stored in code.
 */
import { env } from "../src/app/config/env.js";
import {
  Role,
  ServiceType,
  ShipmentPaymentStatus,
  ShipmentStatus,
  VehicleType,
} from "../src/generated/prisma/enums.js";
import { auth } from "../src/app/lib/auth.js";
import { prisma } from "../src/app/lib/prisma.js";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../src/app/modules/audit/audit.constants.js";
import { calculatePrice } from "../src/app/modules/pricing/pricing.utils.js";
import { allowedTransitions } from "../src/app/modules/shipment/shipment.constants.js";

interface SeedZone {
  code: string;
  name: string;
  description: string;
  hub: { code: string; name: string; address: string; city: string; phone: string };
}

interface SeedUser {
  name: string;
  email: string;
  role: Role;
  phone: string;
  courier?: { zoneCode: string; hubCode: string; vehicleType: VehicleType; vehicleNumber: string };
}

const ZONES: SeedZone[] = [
  {
    code: "DHK-N",
    name: "Dhaka North",
    description: "Uttara, Mirpur, Gulshan, Banani",
    hub: {
      code: "HUB-DHK-N",
      name: "Dhaka North Hub",
      address: "Plot 12, Sector 7, Uttara",
      city: "Dhaka",
      phone: "+8801700000001",
    },
  },
  {
    code: "DHK-S",
    name: "Dhaka South",
    description: "Motijheel, Dhanmondi, Old Dhaka",
    hub: {
      code: "HUB-DHK-S",
      name: "Dhaka South Hub",
      address: "45 Motijheel C/A",
      city: "Dhaka",
      phone: "+8801700000002",
    },
  },
];

const USERS: SeedUser[] = [
  { name: "Carrivo Admin", email: "admin@carrivo.dev", role: Role.ADMIN, phone: "+8801711000000" },
  {
    name: "Rahim Courier",
    email: "courier1@carrivo.dev",
    role: Role.COURIER,
    phone: "+8801711000001",
    courier: { zoneCode: "DHK-N", hubCode: "HUB-DHK-N", vehicleType: VehicleType.MOTORCYCLE, vehicleNumber: "DHAKA-METRO-HA-11-1111" },
  },
  {
    name: "Karim Courier",
    email: "courier2@carrivo.dev",
    role: Role.COURIER,
    phone: "+8801711000002",
    courier: { zoneCode: "DHK-S", hubCode: "HUB-DHK-S", vehicleType: VehicleType.BICYCLE, vehicleNumber: "N/A" },
  },
  { name: "Ayesha Customer", email: "customer1@carrivo.dev", role: Role.CUSTOMER, phone: "+8801711000003" },
  { name: "Tanvir Customer", email: "customer2@carrivo.dev", role: Role.CUSTOMER, phone: "+8801711000004" },
];

const seedZonesAndHubs = async (): Promise<Map<string, string>> => {
  const ids = new Map<string, string>();
  for (const zone of ZONES) {
    const savedZone = await prisma.zone.upsert({
      where: { code: zone.code },
      update: { name: zone.name, description: zone.description, deletedAt: null, isActive: true },
      create: { code: zone.code, name: zone.name, description: zone.description },
    });
    ids.set(zone.code, savedZone.id);

    const savedHub = await prisma.hub.upsert({
      where: { code: zone.hub.code },
      update: { ...zone.hub, zoneId: savedZone.id, deletedAt: null, isActive: true },
      create: { ...zone.hub, zoneId: savedZone.id },
    });
    ids.set(zone.hub.code, savedHub.id);
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

// ───────────── Pricing rules (BDT) ─────────────
interface SeedRule {
  name: string;
  serviceType: ServiceType;
  route: [string, string] | null; // [originZoneCode, destinationZoneCode]; null = default rule
  baseFee: number;
  baseWeightKg: number;
  perKgFee: number;
  maxWeightKg: number | null;
}

// SAME_DAY has no default rule, so it is only offered within a zone
// (an estimate between zones returns 422 "No pricing available").
const PRICING_RULES: SeedRule[] = [
  { name: "Standard - Default", serviceType: ServiceType.STANDARD, route: null, baseFee: 120, baseWeightKg: 1, perKgFee: 20, maxWeightKg: 50 },
  { name: "Standard - Within Dhaka North", serviceType: ServiceType.STANDARD, route: ["DHK-N", "DHK-N"], baseFee: 60, baseWeightKg: 1, perKgFee: 15, maxWeightKg: 50 },
  { name: "Standard - Within Dhaka South", serviceType: ServiceType.STANDARD, route: ["DHK-S", "DHK-S"], baseFee: 60, baseWeightKg: 1, perKgFee: 15, maxWeightKg: 50 },
  { name: "Express - Default", serviceType: ServiceType.EXPRESS, route: null, baseFee: 180, baseWeightKg: 1, perKgFee: 30, maxWeightKg: 30 },
  { name: "Express - Within Dhaka North", serviceType: ServiceType.EXPRESS, route: ["DHK-N", "DHK-N"], baseFee: 100, baseWeightKg: 1, perKgFee: 20, maxWeightKg: 30 },
  { name: "Express - Within Dhaka South", serviceType: ServiceType.EXPRESS, route: ["DHK-S", "DHK-S"], baseFee: 100, baseWeightKg: 1, perKgFee: 20, maxWeightKg: 30 },
  { name: "Same Day - Within Dhaka North", serviceType: ServiceType.SAME_DAY, route: ["DHK-N", "DHK-N"], baseFee: 150, baseWeightKg: 1, perKgFee: 30, maxWeightKg: 10 },
  { name: "Same Day - Within Dhaka South", serviceType: ServiceType.SAME_DAY, route: ["DHK-S", "DHK-S"], baseFee: 150, baseWeightKg: 1, perKgFee: 30, maxWeightKg: 10 },
];

const seedPricingRules = async (ids: Map<string, string>): Promise<number> => {
  for (const rule of PRICING_RULES) {
    const data = {
      name: rule.name,
      serviceType: rule.serviceType,
      originZoneId: rule.route ? requireId(ids, rule.route[0]) : null,
      destinationZoneId: rule.route ? requireId(ids, rule.route[1]) : null,
      baseFee: rule.baseFee,
      baseWeightKg: rule.baseWeightKg,
      perKgFee: rule.perKgFee,
      maxWeightKg: rule.maxWeightKg,
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
  from: "DHK-N" | "DHK-S";
  to: "DHK-N" | "DHK-S";
  serviceType: ServiceType;
  weightKg: number;
  status: ShipmentStatus;
  receiverName: string;
  receiverPhone: string;
  deliveryAddress: string;
  daysAgo: number;
  isFragile?: boolean;
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
const pathTo = (status: ShipmentStatus): ShipmentStatus[] => {
  let path: ShipmentStatus[];
  if (status === ShipmentStatus.CANCELLED) path = [ShipmentStatus.PENDING, ShipmentStatus.CANCELLED];
  else if (status === ShipmentStatus.DELIVERED || status === ShipmentStatus.FAILED_DELIVERY) path = [...HAPPY_PATH, status];
  else path = HAPPY_PATH.slice(0, HAPPY_PATH.indexOf(status) + 1);
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
  { trackingId: "CRV-261101-SEED01", customer: "customer1@carrivo.dev", from: "DHK-N", to: "DHK-S", serviceType: ServiceType.STANDARD, weightKg: 2.3, status: ShipmentStatus.PENDING, receiverName: "Nusrat Jahan", receiverPhone: "+8801811000001", deliveryAddress: "House 5, Road 27, Dhanmondi, Dhaka", daysAgo: 0 },
  { trackingId: "CRV-261101-SEED02", customer: "customer1@carrivo.dev", from: "DHK-N", to: "DHK-N", serviceType: ServiceType.EXPRESS, weightKg: 1, status: ShipmentStatus.PICKUP_SCHEDULED, receiverName: "Imran Hossain", receiverPhone: "+8801811000002", deliveryAddress: "Flat 3B, Road 11, Banani, Dhaka", daysAgo: 1 },
  { trackingId: "CRV-261101-SEED03", customer: "customer2@carrivo.dev", courier: "courier2@carrivo.dev", from: "DHK-S", to: "DHK-S", serviceType: ServiceType.STANDARD, weightKg: 3.5, status: ShipmentStatus.COURIER_ASSIGNED, receiverName: "Farhana Akter", receiverPhone: "+8801811000003", deliveryAddress: "22 Lalbagh Road, Old Dhaka", daysAgo: 2 },
  { trackingId: "CRV-261101-SEED04", customer: "customer1@carrivo.dev", courier: "courier1@carrivo.dev", from: "DHK-N", to: "DHK-S", serviceType: ServiceType.STANDARD, weightKg: 4, status: ShipmentStatus.PICKED_UP, receiverName: "Sabbir Rahman", receiverPhone: "+8801811000004", deliveryAddress: "14 Motijheel C/A, Dhaka", daysAgo: 3, isFragile: true },
  { trackingId: "CRV-261101-SEED05", customer: "customer2@carrivo.dev", courier: "courier2@carrivo.dev", from: "DHK-S", to: "DHK-N", serviceType: ServiceType.EXPRESS, weightKg: 1.8, status: ShipmentStatus.IN_TRANSIT, receiverName: "Mahmudul Hasan", receiverPhone: "+8801811000005", deliveryAddress: "Sector 4, Road 9, Uttara, Dhaka", daysAgo: 4 },
  { trackingId: "CRV-261101-SEED06", customer: "customer1@carrivo.dev", courier: "courier1@carrivo.dev", from: "DHK-N", to: "DHK-N", serviceType: ServiceType.SAME_DAY, weightKg: 0.8, status: ShipmentStatus.OUT_FOR_DELIVERY, receiverName: "Tahmina Sultana", receiverPhone: "+8801811000006", deliveryAddress: "Mirpur 10, Block C, Dhaka", daysAgo: 5 },
  { trackingId: "CRV-261101-SEED07", customer: "customer2@carrivo.dev", courier: "courier2@carrivo.dev", from: "DHK-S", to: "DHK-S", serviceType: ServiceType.STANDARD, weightKg: 5, status: ShipmentStatus.DELIVERED, receiverName: "Arif Chowdhury", receiverPhone: "+8801811000007", deliveryAddress: "8 Shantinagar, Dhaka", daysAgo: 8 },
  { trackingId: "CRV-261101-SEED08", customer: "customer1@carrivo.dev", courier: "courier1@carrivo.dev", from: "DHK-N", to: "DHK-S", serviceType: ServiceType.EXPRESS, weightKg: 2, status: ShipmentStatus.FAILED_DELIVERY, receiverName: "Rumana Islam", receiverPhone: "+8801811000008", deliveryAddress: "Azimpur Govt. Colony, Dhaka", daysAgo: 10 },
  { trackingId: "CRV-261101-SEED09", customer: "customer2@carrivo.dev", from: "DHK-S", to: "DHK-N", serviceType: ServiceType.STANDARD, weightKg: 1.2, status: ShipmentStatus.CANCELLED, receiverName: "Kamal Uddin", receiverPhone: "+8801811000009", deliveryAddress: "Gulshan 2, Road 90, Dhaka", daysAgo: 12 },
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
    const priced = calculatePrice(rule, s.weightKg);
    if (!priced.ok) throw new Error(`Seed: cannot price ${s.trackingId}: ${priced.reason}`);

    const path = pathTo(s.status);
    const createdAt = new Date(Date.now() - s.daysAgo * DAY - path.length * 2 * HOUR);
    const at = (step: number): Date => new Date(createdAt.getTime() + step * 2 * HOUR);
    const reached = (status: ShipmentStatus): number => path.indexOf(status);
    const paid = s.status !== ShipmentStatus.PENDING && s.status !== ShipmentStatus.CANCELLED;

    await prisma.$transaction(async (tx) => {
      const shipment = await tx.shipment.create({
        data: {
          trackingId: s.trackingId,
          customerId,
          courierId: courierId ?? null,
          senderName: customer?.name ?? "Customer",
          senderPhone: customer?.phone ?? "+8801700000000",
          pickupAddress: s.from === "DHK-N" ? "House 10, Road 3, Sector 7, Uttara, Dhaka" : "House 7, Road 2, Dhanmondi, Dhaka",
          receiverName: s.receiverName,
          receiverPhone: s.receiverPhone,
          deliveryAddress: s.deliveryAddress,
          originZoneId,
          destinationZoneId,
          originHubId,
          destinationHubId,
          currentHubId:
            s.status === ShipmentStatus.AT_ORIGIN_HUB ? originHubId : s.status === ShipmentStatus.AT_DESTINATION_HUB ? destinationHubId : null,
          weightKg: s.weightKg,
          description: "Sample parcel (seed data)",
          isFragile: s.isFragile ?? false,
          serviceType: s.serviceType,
          price: priced.breakdown.total,
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
          failedAttempts: s.status === ShipmentStatus.FAILED_DELIVERY ? 1 : 0,
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
          note: step === 0 ? "Shipment created" : null,
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

async function main(): Promise<void> {
  const password = env.SEED_DEMO_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error("SEED_DEMO_PASSWORD must be set in .env (at least 8 characters) before seeding.");
  }

  const ids = await seedZonesAndHubs();
  console.log(`Seed: ${ZONES.length} zones and ${ZONES.length} hubs upserted.`);

  const rules = await seedPricingRules(ids);
  console.log(`Seed: ${rules} pricing rules upserted.`);

  const rows: { role: string; email: string; status: string }[] = [];
  for (const user of USERS) {
    const status = await seedUser(user, password, ids);
    rows.push({ role: user.role, email: user.email, status });
  }

  const users = await prisma.user.findMany({
    where: { email: { in: USERS.map((u) => u.email) } },
    select: { id: true, email: true },
  });
  const shipments = await seedShipments(ids, new Map(users.map((u) => [u.email, u.id])));
  console.log(`Seed: sample shipments ${shipments.created} created, ${shipments.existing} already present.`);

  console.log("\nDemo accounts (all share the password from SEED_DEMO_PASSWORD):");
  console.table(rows);
  console.log(`Password: ${password}\n`);
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
