import type { Role } from "../../../generated/prisma/enums.js";
import type { RequestMeta } from "../../utils/requestMeta.js";
import type { AuditAction, AuditEntity } from "./audit.constants.js";

/** Who performed an action. `null` in an entry means the system (e.g. a webhook). */
export interface Actor {
  id: string;
  role: Role;
}

export interface AuditEntry {
  actor: Actor | null;
  action: AuditAction;
  entityType: AuditEntity;
  entityId: string;
  before?: unknown;
  after?: unknown;
  meta?: RequestMeta;
}

export interface AuditLogItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorRole: Role | null;
  actor: { id: string; name: string; email: string; role: Role } | null;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}
