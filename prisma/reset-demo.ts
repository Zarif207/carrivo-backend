/**
 * Resets demo data, then reseeds the US demo data (npm run db:reset-demo).
 *
 * Deletes: every shipment with its history, pickups, payments, courier earnings and
 * notifications; all audit logs; all pricing rules, hubs and zones; the seeded demo
 * accounts and test accounts (see isDemoOrTestEmail) with their sessions and logins.
 * Keeps: every other registered user, and Stripe event ids (webhook idempotency).
 * Proof-of-delivery images in Cloudinary are not deleted.
 *
 * Guards (reset.safety.ts), checked before the first query: SEED_CONFIRM_DB_HOST must
 * equal the DATABASE_URL host and RESET_CONFIRM must be "reset demo data on <host>".
 * The deletes run in one transaction: on any error nothing is deleted.
 * See docs/DEPLOYMENT.md, "Resetting demo data".
 */
import { spawnSync } from "node:child_process";
import { env } from "../src/app/config/env.js";
import { prisma } from "../src/app/lib/prisma.js";
import { checkResetTarget, isDemoOrTestEmail } from "./reset.safety.js";

async function main(): Promise<void> {
  const target = checkResetTarget({
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    confirmHost: process.env["SEED_CONFIRM_DB_HOST"],
    resetConfirm: process.env["RESET_CONFIRM"],
  });
  if (!target.ok) throw new Error(`Reset refused: ${target.reason}`);
  console.log(`Reset: target database host ${target.host}${env.NODE_ENV === "production" ? " (production)" : ""}.`);

  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  const removeIds = users.filter((u) => isDemoOrTestEmail(u.email)).map((u) => u.id);

  // A kept (real) user with a courier profile points at a zone we are about to delete.
  // Refuse instead of silently changing a real account.
  const keptCouriers = await prisma.courierProfile.count({ where: { userId: { notIn: removeIds } } });
  if (keptCouriers > 0) {
    throw new Error(
      `Reset refused: ${keptCouriers} courier account(s) outside the demo/test set would lose their zone. Deactivate or remove them first. Nothing was deleted.`,
    );
  }

  const counts = await prisma.$transaction(async (tx) => {
    const notifications = await tx.notification.deleteMany({});
    const earnings = await tx.courierEarning.deleteMany({});
    const payments = await tx.payment.deleteMany({});
    const pickups = await tx.pickupRequest.deleteMany({});
    await tx.shipmentStatusHistory.deleteMany({});
    const shipments = await tx.shipment.deleteMany({});
    const auditLogs = await tx.auditLog.deleteMany({});
    await tx.courierProfile.deleteMany({});
    const pricingRules = await tx.pricingRule.deleteMany({});
    const hubs = await tx.hub.deleteMany({});
    const zones = await tx.zone.deleteMany({});
    // Sessions and accounts cascade with the user.
    const accounts = await tx.user.deleteMany({ where: { id: { in: removeIds } } });
    return {
      shipments: shipments.count,
      payments: payments.count,
      earnings: earnings.count,
      pickups: pickups.count,
      notifications: notifications.count,
      auditLogs: auditLogs.count,
      pricingRules: pricingRules.count,
      hubs: hubs.count,
      zones: zones.count,
      demoAndTestAccounts: accounts.count,
      keptUsers: users.length - accounts.count,
    };
  }, { timeout: 60_000 });
  console.log("Reset: deleted");
  console.table(counts);
  await prisma.$disconnect();

  // Reseed with the same environment (the seed applies its own guards and password rules).
  console.log("Reset: reseeding US demo data…");
  const seed = spawnSync("npx", ["tsx", "prisma/seed.ts"], { stdio: "inherit", env: process.env });
  if (seed.status !== 0) throw new Error("Reset: data was deleted but the seed failed; fix the error and run npm run db:seed.");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
