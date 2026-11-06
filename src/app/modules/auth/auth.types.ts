import type { SafeUser } from "../user/user.types.js";

export interface AuthTokenResult {
  /** Signed session token. Send as `Authorization: Bearer <token>`. */
  token: string;
  expiresAt: string;
}

export interface AuthResult extends AuthTokenResult {
  user: SafeUser;
}
