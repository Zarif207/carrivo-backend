import httpStatus from "http-status";
import { getAuthUser } from "../../middlewares/authenticate.js";
import { getValidatedQuery } from "../../middlewares/validateRequest.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { NotificationService } from "./notification.service.js";
import type { MyNotificationsQuery } from "./notification.validation.js";

const listMine = catchAsync(async (req, res) => {
  const { data, meta } = await NotificationService.listMine(getAuthUser(req).id, getValidatedQuery<MyNotificationsQuery>(res));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Notifications retrieved successfully", data, meta });
});

const markRead = catchAsync(async (req, res) => {
  const data = await NotificationService.markRead(getAuthUser(req).id, String(req.params["id"]));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Notification marked as read", data });
});

const markAllRead = catchAsync(async (req, res) => {
  const data = await NotificationService.markAllRead(getAuthUser(req).id);
  sendResponse(res, { statusCode: httpStatus.OK, message: "All notifications marked as read", data });
});

export const NotificationController = { listMine, markRead, markAllRead };
