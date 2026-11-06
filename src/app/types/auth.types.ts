import type { Role, UserStatus } from "../../generated/prisma/enums.js";

/** The authenticated user attached to `req.user` by the authenticate middleware. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
}

/** The current session attached to `req.session` by the authenticate middleware. */
export interface AuthSession {
  id: string;
  token: string;
  expiresAt: Date;
}
