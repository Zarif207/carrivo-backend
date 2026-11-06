import { fromNodeHeaders } from "better-auth/node";
import type { CookieOptions, Response } from "express";
import httpStatus from "http-status";
import { env } from "../../config/env.js";
import { AUTH_BASE_PATH, auth } from "../../lib/auth.js";
import { getAuthSession, getAuthUser } from "../../middlewares/authenticate.js";
import { getValidatedQuery } from "../../middlewares/validateRequest.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { getRequestMeta } from "../../utils/requestMeta.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { readCookie, signValue, unsignValue } from "./auth.google.utils.js";
import { AuthService, googleErrorRedirect } from "./auth.service.js";
import type { GoogleCompleteQuery, GoogleExchangeInput, GoogleStartQuery, LoginInput, RegisterInput } from "./auth.validation.js";

const register = catchAsync(async (req, res) => {
  const result = await AuthService.register(req.body as RegisterInput, fromNodeHeaders(req.headers), getRequestMeta(req));
  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: "Registration successful",
    data: result,
  });
});

const login = catchAsync(async (req, res) => {
  const result = await AuthService.login(req.body as LoginInput, fromNodeHeaders(req.headers));
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: "Login successful",
    data: result,
  });
});

const logout = catchAsync(async (req, res) => {
  await AuthService.logout(fromNodeHeaders(req.headers));
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: "Logout successful",
    data: null,
  });
});

const refreshToken = catchAsync(async (req, res) => {
  const result = await AuthService.refreshToken(getAuthUser(req).id, getAuthSession(req));
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: "Session refreshed",
    data: result,
  });
});

// ───────── Google ─────────

/** Holds the PKCE challenge between the start and complete steps (API domain, httpOnly, signed). */
const CHALLENGE_COOKIE = "carrivo_google_challenge";
const secureCookies = env.BETTER_AUTH_URL.startsWith("https://");
const challengeCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: secureCookies,
  sameSite: "lax", // sent on the top-level redirect back from Google
  path: `${AUTH_BASE_PATH}/google`,
};

/** Never cache any step of the handoff (responses carry cookies or one-time codes). */
const noStore = (res: Response): void => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
};

/** GET /auth/google?challenge=...: a browser navigation, answered with a 302 to Google. */
const googleStart = catchAsync(async (req, res) => {
  const { challenge } = getValidatedQuery<GoogleStartQuery>(res);
  const { url, setCookies } = await AuthService.startGoogle(fromNodeHeaders(req.headers));
  noStore(res);
  for (const cookie of setCookies) res.append("Set-Cookie", cookie);
  res.cookie(CHALLENGE_COOKIE, signValue(challenge, env.BETTER_AUTH_SECRET), { ...challengeCookieOptions, maxAge: 10 * 60_000 });
  res.redirect(httpStatus.FOUND, url);
});

/** Expires Better Auth's cookies and ours: the session must only ever leave via the code exchange. */
const clearAuthCookies = async (res: Response): Promise<void> => {
  const { authCookies } = await auth.$context;
  for (const cookie of [authCookies.sessionToken, authCookies.sessionData, authCookies.dontRememberToken]) {
    const { path, domain, secure, sameSite, httpOnly } = cookie.attributes;
    res.clearCookie(cookie.name, {
      path: path ?? "/",
      ...(domain ? { domain } : {}),
      ...(secure !== undefined ? { secure } : {}),
      ...(httpOnly !== undefined ? { httpOnly } : {}),
      ...(typeof sameSite === "string" ? { sameSite: sameSite.toLowerCase() as "lax" | "strict" | "none" } : {}),
    });
  }
  res.clearCookie(CHALLENGE_COOKIE, challengeCookieOptions);
};

/** GET /auth/google/complete: Better Auth redirects here; we redirect to the frontend with ?code= or ?error=. */
const googleComplete = catchAsync(async (req, res) => {
  noStore(res);
  let target: string;
  try {
    const challenge = unsignValue(readCookie(req.headers.cookie, CHALLENGE_COOKIE), env.BETTER_AUTH_SECRET);
    target = await AuthService.completeGoogle(fromNodeHeaders(req.headers), getValidatedQuery<GoogleCompleteQuery>(res), challenge);
  } catch (error) {
    console.warn(`[auth] Google sign-in could not be completed: ${error instanceof Error ? error.name : "unknown error"}`);
    target = googleErrorRedirect("google_failed");
  }
  await clearAuthCookies(res);
  res.redirect(httpStatus.FOUND, target);
});

/** POST /auth/google/exchange { code, codeVerifier } → { token, expiresAt, user } */
const googleExchange = catchAsync(async (req, res) => {
  const { code, codeVerifier } = req.body as GoogleExchangeInput;
  noStore(res);
  const data = await AuthService.exchangeGoogle(code, codeVerifier, getRequestMeta(req));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Google sign-in successful", data });
});

export const AuthController = { register, login, logout, refreshToken, googleStart, googleComplete, googleExchange };
