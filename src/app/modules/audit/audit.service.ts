import { Prisma } from "../../../generated/prisma/client.js";
import type { AuditEntry } from "./audit.types.js";

/** Decimals become strings and Dates ISO strings, which is what we want in a JSON column. */
const toJson = (value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  value === undefined || value === null
    ? Prisma.DbNull
    : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);

/**
 * Writes one audit row. Always called with the transaction client of the change
 * it describes, so the audit row commits or rolls back together with it.
 */
const log = async (db: Prisma.TransactionClient, entry: AuditEntry): Promise<void> => {
  await db.auditLog.create({
    data: {
      actorId: entry.actor?.id ?? null,
      actorRole: entry.actor?.role ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: toJson(entry.before),
      after: toJson(entry.after),
      ipAddress: entry.meta?.ipAddress ?? null,
      userAgent: entry.meta?.userAgent ?? null,
    },
    select: { id: true },
  });
};

export const AuditService = { log };
