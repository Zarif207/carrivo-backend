import type { Server } from "node:http";
import app from "./app.js";
import { env } from "./app/config/env.js";
import { prisma } from "./app/lib/prisma.js";

let server: Server | undefined;

const shutdown = (signal: string, exitCode = 0): void => {
  console.log(`${signal} received, shutting down...`);
  const finish = (): void => {
    prisma
      .$disconnect()
      .catch((error: unknown) => console.error("Error disconnecting Prisma:", error))
      .finally(() => process.exit(exitCode));
  };
  if (server) {
    server.close(finish);
  } else {
    finish();
  }
};

const bootstrap = (): void => {
  server = app.listen(env.PORT, () => {
    console.log(`Carrivo API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason: unknown) => {
  console.error("Unhandled rejection:", reason);
  shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (error: Error) => {
  console.error("Uncaught exception:", error);
  shutdown("uncaughtException", 1);
});

bootstrap();
