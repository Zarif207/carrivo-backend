/**
 * Idempotent seed: safe to run any number of times.
 * - Zones and hubs are upserted by `code`.
 * - Users are created through Better Auth (so passwords are hashed by Better Auth),
 *   skipped if the email already exists, then their role/profile is (re)applied.
 *
 * The demo password comes from SEED_DEMO_PASSWORD; it is never stored in code.
 */
import { env } from "../src/app/config/env.js";
import { Role, VehicleType } from "../src/generated/prisma/enums.js";
import { auth } from "../src/app/lib/auth.js";
import { prisma } from "../src/app/lib/prisma.js";

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

async function main(): Promise<void> {
  const password = env.SEED_DEMO_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error("SEED_DEMO_PASSWORD must be set in .env (at least 8 characters) before seeding.");
  }

  const ids = await seedZonesAndHubs();
  console.log(`Seed: ${ZONES.length} zones and ${ZONES.length} hubs upserted.`);

  const rows: { role: string; email: string; status: string }[] = [];
  for (const user of USERS) {
    const status = await seedUser(user, password, ids);
    rows.push({ role: user.role, email: user.email, status });
  }

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
