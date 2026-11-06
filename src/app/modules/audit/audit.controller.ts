import httpStatus from "http-status";
import { getValidatedQuery } from "../../middlewares/validateRequest.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { AuditService } from "./audit.service.js";
import type { AuditLogQuery } from "./audit.validation.js";

const list = catchAsync(async (_req, res) => {
  const { data, meta } = await AuditService.list(getValidatedQuery<AuditLogQuery>(res));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Audit logs retrieved successfully", data, meta });
});

export const AuditController = { list };
