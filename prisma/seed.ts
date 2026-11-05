// Seed script. Phase 2 fills this in: users are created through the Better Auth
// API so passwords hash correctly, then hubs, zones, pricing rules and sample shipments.
import { prisma } from "../src/app/lib/prisma.js";

async function main(): Promise<void> {
  console.log("Seed: nothing to seed yet (Phase 2 adds users and sample data).");
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
