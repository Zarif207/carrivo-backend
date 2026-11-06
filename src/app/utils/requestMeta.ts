import type { Request } from "express";

/** Client details recorded on audit log rows. */
export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

export const getRequestMeta = (req: Request): RequestMeta => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get("user-agent")?.slice(0, 500) ?? null,
});
