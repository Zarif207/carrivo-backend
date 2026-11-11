import httpStatus from "http-status";
import { getAuthUser } from "../../middlewares/authenticate.js";
import { getValidatedQuery } from "../../middlewares/validateRequest.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { getRequestMeta } from "../../utils/requestMeta.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { CourierApplicationService } from "./courierApplication.service.js";
import type { AdminApplicationListQuery, ApplyInput, ApproveInput, RejectInput } from "./courierApplication.validation.js";

const id = (params: Record<string, unknown>): string => String(params["id"]);

const apply = catchAsync(async (req, res) => {
  const data = await CourierApplicationService.apply(getAuthUser(req), req.body as ApplyInput, getRequestMeta(req));
  sendResponse(res, { statusCode: httpStatus.CREATED, message: "Courier application submitted", data });
});

const getMine = catchAsync(async (req, res) => {
  const data = await CourierApplicationService.getMine(getAuthUser(req));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Courier applications retrieved successfully", data });
});

const cancelMine = catchAsync(async (req, res) => {
  const data = await CourierApplicationService.cancelMine(getAuthUser(req), id(req.params), getRequestMeta(req));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Courier application cancelled", data });
});

const adminList = catchAsync(async (_req, res) => {
  const { data, meta } = await CourierApplicationService.adminList(getValidatedQuery<AdminApplicationListQuery>(res));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Courier applications retrieved successfully", data, meta });
});

const adminGet = catchAsync(async (req, res) => {
  const data = await CourierApplicationService.adminGet(id(req.params));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Courier application retrieved successfully", data });
});

const approve = catchAsync(async (req, res) => {
  const data = await CourierApplicationService.approve(getAuthUser(req), id(req.params), req.body as ApproveInput, getRequestMeta(req));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Courier application approved; the applicant is now a courier and must sign in again", data });
});

const reject = catchAsync(async (req, res) => {
  const data = await CourierApplicationService.reject(getAuthUser(req), id(req.params), req.body as RejectInput, getRequestMeta(req));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Courier application rejected", data });
});

export const CourierApplicationController = { apply, getMine, cancelMine, adminList, adminGet, approve, reject };
