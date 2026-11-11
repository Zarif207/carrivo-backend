/**
 * The courier seed's flow with its database access passed in (so seed-couriers.test.ts can run it
 * against an in-memory fake). prisma/seed-couriers.ts supplies the real Prisma / Better Auth calls.
 *
 * Nothing here can notify anyone: the only write is `createCourier`, and the run checks that the
 * notification count is unchanged afterwards (it throws if it isn't).
 */
import { planCourierSeed, type CourierSeedPlan, type DbZone, type PlannedCourier } from "./seed-couriers.plan.js";

export interface CourierSeedDeps {
  loadZones: () => Promise<DbZone[]>;
  /** Which of these emails already belong to a user (any role, deleted ones included). */
  existingEmails: (emails: readonly string[]) => Promise<Set<string>>;
  createCourier: (courier: PlannedCourier) => Promise<void>;
  countNotifications: () => Promise<number>;
  log: (line: string) => void;
}

export interface CourierSeedResult {
  plan: CourierSeedPlan;
  created: number;
  notificationsBefore: number;
  notificationsAfter: number;
}

export async function runCourierSeed(deps: CourierSeedDeps, options: { dryRun: boolean }): Promise<CourierSeedResult> {
  const zones = await deps.loadZones();
  // First pass only to learn the candidate emails, then the real plan with what exists.
  const candidates = planCourierSeed(zones, new Set()).create.map((courier) => courier.email);
  const plan = planCourierSeed(zones, await deps.existingEmails(candidates));
  const notificationsBefore = await deps.countNotifications();

  if (options.dryRun) return { plan, created: 0, notificationsBefore, notificationsAfter: notificationsBefore };

  let created = 0;
  for (const courier of plan.create) {
    await deps.createCourier(courier);
    created += 1;
    deps.log(`  created ${courier.email} (${courier.zoneCode}${courier.hubCode ? `, ${courier.hubCode}` : ""}, ${courier.vehicleType})`);
  }
  const notificationsAfter = await deps.countNotifications();
  if (notificationsAfter !== notificationsBefore) {
    throw new Error(`Courier seed: notifications changed (${notificationsBefore} → ${notificationsAfter}); seeding must not notify anyone.`);
  }
  return { plan, created, notificationsBefore, notificationsAfter };
}
