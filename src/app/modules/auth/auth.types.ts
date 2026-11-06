import type { SafeUser } from "../user/user.types.js";

export interface AuthTokenResult {
  /** Signed session token. Send as `Authorization: Bearer <token>`. */
  token: string;
  expiresAt: string;
}

export interface AuthResult extends AuthTokenResult {
  user: SafeUser;
}

export interface GoogleStartResult {
  /** Google's authorization URL (the browser is redirected there). */
  url: string;
  /** Better Auth's OAuth state cookie(s), forwarded as-is. */
  setCookies: string[];
}
