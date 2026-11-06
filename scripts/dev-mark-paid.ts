/**
 * DEV ONLY: marks shipments as PAID so the workflow can be tested before Stripe
 * (Phase 6). There is no HTTP route for this; it is a local CLI script and is
 * never imported by the app or api/index.ts.
 *
 *   DEV_ALLOW_MARK_PAID=true npm run dev:mark-paid -- CRV-261106-ABC123 [more ids...]
 *
 * Refuses to run unless DEV_ALLOW_MARK_PAID=true, and always refuses when
 * NODE_ENV=production or when running on Vercel. Never set the flag in Vercel.
 */
import "dotenv/config";

const fail = (message: string): never => {
  console.error(`dev:mark-paid refused: ${message}`);
  process.exit(1);
};

// Checked before anything touches the database.
if (process.env["NODE_ENV"] === "production") fail("NODE_ENV is production.");
if (process.env["VERCEL"]) fail("running on Vercel.");
if (process.env["DEV_ALLOW_MARK_PAID"] !== "true") fail("set DEV_ALLOW_MARK_PAID=true to allow it (local development only).");

const trackingIds = process.argv.slice(2).map((id) => id.trim().toUpperCase()).filter(Boolean);
if (trackingIds.length === 0) fail("pass one or more tracking ids, e.g. npm run dev:mark-paid -- CRV-261106-ABC123");

// Imported only after the guards pass.
const { prisma } = await import("../src/app/lib/prisma.js");
const { AUDIT_ACTIONS, AUDIT_ENTITIES } = await import("../src/app/modules/audit/audit.constants.js");
const { PaymentStatus, ShipmentPaymentStatus } = await import("../src/generated/prisma/enums.js");
const { PLATFORM_CURRENCY } = await import("../src/app/config/currency.js");

try {
  for (const trackingId of trackingIds) {
    const shipment = await prisma.shipment.findFirst({
      where: { trackingId, deletedAt: null },
      select: { id: true, paymentStatus: true, status: true, price: true, customerId: true },
    });
    if (!shipment) {
      console.log(`${trackingId}: not found`);
      continue;
    }
    if (shipment.paymentStatus === ShipmentPaymentStatus.PAID) {
      console.log(`${trackingId}: already PAID (status ${shipment.status})`);
      continue;
    }
    await prisma.$transaction(async (tx) => {
      // Guarded so a concurrent change can't be overwritten.
      const { count } = await tx.shipment.updateMany({
        where: { id: shipment.id, paymentStatus: shipment.paymentStatus },
        data: { paymentStatus: ShipmentPaymentStatus.PAID },
      });
      if (count === 0) throw new Error(`${trackingId}: payment status changed concurrently`);
      // A DEV payment row (no Stripe ids) keeps payment lists and revenue consistent.
      const payment = await tx.payment.create({
        data: {
          shipmentId: shipment.id,
          userId: shipment.customerId,
          amount: shipment.price,
          paidAmount: shipment.price,
          currency: PLATFORM_CURRENCY,
          paidCurrency: PLATFORM_CURRENCY,
          status: PaymentStatus.PAID,
          provider: "DEV",
          paidAt: new Date(),
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          actorId: null,
          actorRole: null,
          action: AUDIT_ACTIONS.DEV_MARK_PAID,
          entityType: AUDIT_ENTITIES.SHIPMENT,
          entityId: shipment.id,
          before: { paymentStatus: shipment.paymentStatus },
          after: { paymentStatus: ShipmentPaymentStatus.PAID, paymentId: payment.id, source: "scripts/dev-mark-paid.ts" },
        },
      });
    });
    console.log(`${trackingId}: ${shipment.paymentStatus} -> PAID (status ${shipment.status})`);
  }
} finally {
  await prisma.$disconnect();
}
