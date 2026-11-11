/**
 * Adds demo courier drivers, 2 per zone and 3 in the biggest metros, spread round-robin over each
 * zone's hubs (npm run db:seed-couriers [-- --dry-run]). Separate from prisma/seed.ts so it can run
 * on its own, including against production once confirmed (see README, "Demo couriers per zone").
 *
 * Additive only: zones and hubs are looked up BY NAME in the target database; a roster email that
 * already exists is left exactly as it is; nothing is ever updated or deleted.
 *
 * Each courier is created like the admin "create courier" flow, minus its side effects:
 * - Better Auth signUpEmail (the same credential handling as prisma/seed.ts), so the password is
 *   hashed by Better Auth. No verification email is configured, so sign-up sends nothing;
 * - then one transaction: role COURIER, ACTIVE, email verified; the app's own
 *   AdminUserRules.upsertCourierProfile (validates zone and hub, available = on); the sign-up
 *   session removed; a USER_CREATED audit row (actor: none, source: this script).
 *   If it fails, the just-created user is deleted again (no half-made accounts);
 * - AdminService.createUser is NOT called: that is where StaffNotify.courierAdded runs. No
 *   notification and no email is created; the run checks the notification count is unchanged.
 *
 * Passwords: a random one per account (never stored or shown), so nobody can log in, unless
 * SEED_COURIER_LOGIN_PASSWORD is set (local testing). Passwords are never printed.
 * Guards: seed-couriers.safety.ts.
 */
import { randomBytes } from "node:crypto";
import { Role } from "../src/generated/prisma/enums.js";
import { env } from "../src/app/config/env.js";
import { auth } from "../src/app/lib/auth.js";
import { prisma } from "../src/app/lib/prisma.js";
import { AdminUserRules } from "../src/app/modules/admin/admin.service.js";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../src/app/modules/audit/audit.constants.js";
import { AuditService } from "../src/app/modules/audit/audit.service.js";
import type { PlannedCourier } from "./seed-couriers.plan.js";
import { runCourierSeed, type CourierSeedDeps } from "./seed-couriers.run.js";
import { checkCourierSeedTarget } from "./seed-couriers.safety.js";

const randomPassword = (): string => randomBytes(32).toString("base64url");

const createCourier =
  (loginPassword: string | undefined) =>
  async (courier: PlannedCourier): Promise<void> => {
    const result = await auth.api.signUpEmail({
      body: { name: courier.name, email: courier.email, password: loginPassword ?? randomPassword(), phone: courier.phone },
    });
    const userId = result.user.id;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { role: Role.COURIER, status: "ACTIVE", emailVerified: true } });
        await AdminUserRules.upsertCourierProfile(tx, userId, {
          zoneId: courier.zoneId,
          hubId: courier.hubId,
          vehicleType: courier.vehicleType,
          vehicleNumber: courier.vehicleNumber,
        });
        // Sign-up signs the new user in; nobody needs that session.
        await tx.session.deleteMany({ where: { userId } });
        await AuditService.log(tx, {
          actor: null,
          action: AUDIT_ACTIONS.USER_CREATED,
          entityType: AUDIT_ENTITIES.USER,
          entityId: userId,
          after: {
            email: courier.email,
            name: courier.name,
            role: Role.COURIER,
            courierProfile: { zoneId: courier.zoneId, hubId: courier.hubId, vehicleType: courier.vehicleType, vehicleNumber: courier.vehicleNumber },
            source: "prisma/seed-couriers.ts",
          },
        });
      });
    } catch (error) {
      // Compensate: only the user this run just created (sessions and accounts cascade).
      await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
      throw error;
    }
  };

const deps = (loginPassword: string | undefined): CourierSeedDeps => ({
  loadZones: () =>
    prisma.zone.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        code: true,
        name: true,
        hubs: { where: { deletedAt: null, isActive: true }, orderBy: { code: "asc" }, select: { id: true, code: true } },
      },
    }),
  existingEmails: async (emails) => {
    const users = await prisma.user.findMany({ where: { email: { in: [...emails], mode: "insensitive" } }, select: { email: true } });
    return new Set(users.map((user) => user.email.toLowerCase()));
  },
  createCourier: createCourier(loginPassword),
  countNotifications: () => prisma.notification.count(),
  log: (line) => console.log(line),
});

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const loginPassword = process.env["SEED_COURIER_LOGIN_PASSWORD"] || undefined;
  const target = checkCourierSeedTarget({
    databaseUrl: env.DATABASE_URL,
    confirmHost: process.env["SEED_CONFIRM_DB_HOST"],
    confirmPhrase: process.env["SEED_COURIERS_CONFIRM"],
    loginPassword,
    dryRun,
  });
  if (!target.ok) throw new Error(`Courier seed refused: ${target.reason}`);
  console.log(
    `Courier seed${dryRun ? " (dry run: nothing is written)" : ""}: database host ${target.host}${target.local ? " (local)" : ""}; ` +
      `logins ${loginPassword ? "use SEED_COURIER_LOGIN_PASSWORD" : "disabled (random unknown passwords)"}.`,
  );

  const result = await runCourierSeed(deps(loginPassword), { dryRun });
  const { plan } = result;
  console.table(plan.perZone.map((z) => ({ zone: z.zone, code: z.code, hubs: z.hubs, couriers: z.planned, [dryRun ? "wouldCreate" : "created"]: z.create })));
  if (dryRun && plan.create.length > 0) {
    console.table(plan.create.map((c) => ({ email: c.email, name: c.name, phone: c.phone, hub: c.hubCode ?? "-", vehicle: c.vehicleType, plate: c.vehicleNumber ?? "-" })));
  }
  if (plan.skippedZones.length > 0) console.log(`Skipped (not in this database): ${plan.skippedZones.join(", ")}`);
  if (plan.unrosteredZones.length > 0) console.log(`No roster for (nothing created): ${plan.unrosteredZones.join(", ")}`);
  console.log(
    `${dryRun ? "Would create" : "Created"} ${dryRun ? plan.create.length : result.created}; already present ${plan.existing.length}; ` +
      `notifications ${result.notificationsBefore} → ${result.notificationsAfter}.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
