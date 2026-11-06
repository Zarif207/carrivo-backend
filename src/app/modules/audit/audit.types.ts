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
