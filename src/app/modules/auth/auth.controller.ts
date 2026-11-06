import { fromNodeHeaders } from "better-auth/node";
import httpStatus from "http-status";
import { getAuthSession, getAuthUser } from "../../middlewares/authenticate.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { AuthService } from "./auth.service.js";
import type { LoginInput, RegisterInput } from "./auth.validation.js";

const register = catchAsync(async (req, res) => {
  const result = await AuthService.register(req.body as RegisterInput, fromNodeHeaders(req.headers));
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

/** TEMPORARY: verifies ADMIN-only authorization. Remove once real admin routes exist (Phase 5). */
const adminCheck = catchAsync(async (req, res) => {
  const user = getAuthUser(req);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: "Admin access confirmed",
    data: { ok: true, userId: user.id, role: user.role },
  });
});

export const AuthController = { register, login, logout, refreshToken, adminCheck };
