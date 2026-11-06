import httpStatus from "http-status";
import { getAuthUser } from "../../middlewares/authenticate.js";
import { getValidatedQuery } from "../../middlewares/validateRequest.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { getRequestMeta } from "../../utils/requestMeta.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { ZoneService } from "./zone.service.js";
import type { CreateZoneInput, UpdateZoneInput, ZoneListQuery } from "./zone.validation.js";

const list = catchAsync(async (_req, res) => {
  const { data, meta } = await ZoneService.list(getValidatedQuery<ZoneListQuery>(res));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Zones retrieved successfully", data, meta });
});

const getById = catchAsync(async (req, res) => {
  const data = await ZoneService.getById(String(req.params["id"]));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Zone retrieved successfully", data });
});

const create = catchAsync(async (req, res) => {
  const data = await ZoneService.create(req.body as CreateZoneInput, getAuthUser(req), getRequestMeta(req));
  sendResponse(res, { statusCode: httpStatus.CREATED, message: "Zone created successfully", data });
});

const update = catchAsync(async (req, res) => {
  const data = await ZoneService.update(
    String(req.params["id"]),
    req.body as UpdateZoneInput,
    getAuthUser(req),
    getRequestMeta(req),
  );
  sendResponse(res, { statusCode: httpStatus.OK, message: "Zone updated successfully", data });
});

const remove = catchAsync(async (req, res) => {
  const data = await ZoneService.remove(String(req.params["id"]), getAuthUser(req), getRequestMeta(req));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Zone deleted successfully", data });
});

export const ZoneController = { list, getById, create, update, remove };
