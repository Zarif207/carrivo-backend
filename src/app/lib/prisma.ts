import { PrismaPg } from "@prisma/adapter-pg";
import { attachDatabasePool } from "@vercel/functions";
import pg from "pg";
import { env, isProduction } from "../config/env.js";
import { PrismaClient } from "../../generated/prisma/client.js";

// Reuse one client across hot reloads (dev) and warm serverless invocations.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const createPrismaClient = (): PrismaClient => {
  // We own the pg pool (instead of passing a connection string) so Vercel's Fluid
  // compute can release idle connections before an instance is suspended. Off
  // Vercel attachDatabasePool does nothing. DATABASE_URL is the POOLED Neon URL,
  // so a small per-instance pool is plenty.
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5, idleTimeoutMillis: 10_000 });
  attachDatabasePool(pool);
  const adapter = new PrismaPg(pool, { disposeExternalPool: true }); // $disconnect also ends the pool
  return new PrismaClient({
    adapter,
    log: isProduction ? ["error"] : ["warn", "error"],
  });
};

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

globalForPrisma.prisma = prisma;
