import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import type { DatabaseState, HealthStatus } from "./health.types.js";

const DB_CHECK_TIMEOUT_MS = 3000;

const checkDatabase = async (): Promise<DatabaseState> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<DatabaseState>((resolve) => {
    timer = setTimeout(() => resolve("down"), DB_CHECK_TIMEOUT_MS);
  });
  const ping = prisma.$queryRaw`SELECT 1`.then(
    (): DatabaseState => "up",
    (): DatabaseState => "down",
  );
  try {
    return await Promise.race([ping, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const getHealth = async (): Promise<HealthStatus> => ({
  status: "ok",
  environment: env.NODE_ENV,
  uptime: Math.round(process.uptime()),
  timestamp: new Date().toISOString(),
  database: await checkDatabase(),
});

export const HealthService = { getHealth };
