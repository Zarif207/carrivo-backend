import httpStatus from "http-status";
import { getAuthUser } from "../../middlewares/authenticate.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { UserService } from "./user.service.js";
import type { UpdateMeInput } from "./user.validation.js";

const getMe = catchAsync(async (req, res) => {
  const result = await UserService.getMe(getAuthUser(req).id);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: "Profile retrieved successfully",
    data: result,
  });
});

const updateMe = catchAsync(async (req, res) => {
  const result = await UserService.updateMe(getAuthUser(req).id, req.body as UpdateMeInput);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: "Profile updated successfully",
    data: result,
  });
});

export const UserController = { getMe, updateMe };
