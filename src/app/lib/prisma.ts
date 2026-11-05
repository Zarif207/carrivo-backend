import { PrismaPg } from "@prisma/adapter-pg";
import { env, isProduction } from "../config/env.js";
import { PrismaClient } from "../../generated/prisma/client.js";

// Reuse one client across hot reloads (dev) and warm serverless invocations.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const createPrismaClient = (): PrismaClient => {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    log: isProduction ? ["error"] : ["warn", "error"],
  });
};

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

globalForPrisma.prisma = prisma;
