import httpStatus from "http-status";
import { getAuthUser } from "../../middlewares/authenticate.js";
import { getValidatedQuery } from "../../middlewares/validateRequest.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { getRequestMeta } from "../../utils/requestMeta.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { AdminService } from "./admin.service.js";
import type { AdminUserListQuery, ChangeRoleInput, ChangeStatusInput, CreateUserInput } from "./admin.validation.js";

const listUsers = catchAsync(async (_req, res) => {
  const { data, meta } = await AdminService.listUsers(getValidatedQuery<AdminUserListQuery>(res));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Users retrieved successfully", data, meta });
});

const createUser = catchAsync(async (req, res) => {
  const data = await AdminService.createUser(getAuthUser(req), req.body as CreateUserInput, getRequestMeta(req));
  sendResponse(res, { statusCode: httpStatus.CREATED, message: "User created successfully", data });
});

const changeRole = catchAsync(async (req, res) => {
  const data = await AdminService.changeRole(
    getAuthUser(req),
    String(req.params["id"]),
    req.body as ChangeRoleInput,
    getRequestMeta(req),
  );
  sendResponse(res, { statusCode: httpStatus.OK, message: "User role updated successfully", data });
});

const changeStatus = catchAsync(async (req, res) => {
  const data = await AdminService.changeStatus(
    getAuthUser(req),
    String(req.params["id"]),
    req.body as ChangeStatusInput,
    getRequestMeta(req),
  );
  sendResponse(res, { statusCode: httpStatus.OK, message: "User status updated successfully", data });
});

const dashboardStats = catchAsync(async (_req, res) => {
  const data = await AdminService.dashboardStats();
  sendResponse(res, { statusCode: httpStatus.OK, message: "Dashboard stats retrieved successfully", data });
});

export const AdminController = { listUsers, createUser, changeRole, changeStatus, dashboardStats };
