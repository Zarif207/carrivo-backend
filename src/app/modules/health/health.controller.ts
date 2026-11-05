import httpStatus from "http-status";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { HealthService } from "./health.service.js";

const getHealth = catchAsync(async (_req, res) => {
  const result = await HealthService.getHealth();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: "Server is healthy",
    data: result,
  });
});

export const HealthController = { getHealth };
