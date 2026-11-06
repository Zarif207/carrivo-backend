import httpStatus from "http-status";
import { getAuthUser } from "../../middlewares/authenticate.js";
import { getValidatedQuery } from "../../middlewares/validateRequest.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { getRequestMeta } from "../../utils/requestMeta.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { CourierService } from "./courier.service.js";
import type {
  AvailabilityInput,
  CourierEarningQuery,
  CourierListQuery,
  CourierTaskQuery,
} from "./courier.validation.js";

const list = catchAsync(async (_req, res) => {
  const { data, meta } = await CourierService.list(getValidatedQuery<CourierListQuery>(res));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Couriers retrieved successfully", data, meta });
});

const myTasks = catchAsync(async (req, res) => {
  const { data, meta } = await CourierService.myTasks(getAuthUser(req), getValidatedQuery<CourierTaskQuery>(res));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Tasks retrieved successfully", data, meta });
});

const myEarnings = catchAsync(async (req, res) => {
  const { data, meta } = await CourierService.myEarnings(getAuthUser(req), getValidatedQuery<CourierEarningQuery>(res));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Earnings retrieved successfully", data, meta });
});

const setAvailability = catchAsync(async (req, res) => {
  const data = await CourierService.setAvailability(getAuthUser(req), req.body as AvailabilityInput, getRequestMeta(req));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Availability updated successfully", data });
});

export const CourierController = { list, myTasks, myEarnings, setAvailability };
