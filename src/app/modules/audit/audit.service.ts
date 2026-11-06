import { Prisma } from "../../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { buildMeta, getSkipTake, type Paginated } from "../../utils/pagination.js";
import type { AuditEntry, AuditLogItem } from "./audit.types.js";
import { redactSecrets } from "./audit.utils.js";
import type { AuditLogQuery } from "./audit.validation.js";

/** Decimals become strings and Dates ISO strings, which is what we want in a JSON column. */
const toJson = (value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  value === undefined || value === null
    ? Prisma.DbNull
    : (redactSecrets(JSON.parse(JSON.stringify(value))) as Prisma.InputJsonValue);

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

/** Admin: filtered, paginated audit trail (newest first). Snapshots are redacted again on read. */
const list = async (query: AuditLogQuery): Promise<Paginated<AuditLogItem>> => {
  const where: Prisma.AuditLogWhereInput = {
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...(query.entityType ? { entityType: query.entityType } : {}),
    ...(query.entityId ? { entityId: query.entityId } : {}),
    ...(query.fromDate || query.toDate
      ? { createdAt: { ...(query.fromDate ? { gte: query.fromDate } : {}), ...(query.toDate ? { lte: query.toDate } : {}) } }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        actorRole: true,
        actor: { select: { id: true, name: true, email: true, role: true } },
        before: true,
        after: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: query.sortOrder }, { id: query.sortOrder }],
      ...getSkipTake(query),
    }),
    prisma.auditLog.count({ where }),
  ]);
  const data = rows.map((row) => ({ ...row, before: redactSecrets(row.before), after: redactSecrets(row.after) }));
  return { data, meta: buildMeta(query, total) };
};

export const AuditService = { log, list };
