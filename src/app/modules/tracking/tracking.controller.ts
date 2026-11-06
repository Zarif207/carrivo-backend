import httpStatus from "http-status";
import type { ValidatedRequest } from "../../middlewares/validateRequest.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { TrackingService } from "./tracking.service.js";
import type { TrackingParams } from "./tracking.validation.js";

const track = catchAsync(async (_req, res) => {
  // Use the validated (trimmed, upper-cased) param, not the raw one.
  const { trackingId } = (res.locals["validated"] as ValidatedRequest).params as TrackingParams;
  const data = await TrackingService.track(trackingId);
  sendResponse(res, { statusCode: httpStatus.OK, message: "Tracking information retrieved successfully", data });
});

export const TrackingController = { track };
