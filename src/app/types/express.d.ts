import type { AuthSession, AuthUser } from "./auth.types.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      authSession?: AuthSession;
    }
  }
}

export {};
