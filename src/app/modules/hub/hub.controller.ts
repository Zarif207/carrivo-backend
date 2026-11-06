import httpStatus from "http-status";
import { getAuthUser } from "../../middlewares/authenticate.js";
import { getValidatedQuery } from "../../middlewares/validateRequest.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { getRequestMeta } from "../../utils/requestMeta.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { HubService } from "./hub.service.js";
import type { CreateHubInput, HubListQuery, UpdateHubInput } from "./hub.validation.js";

const list = catchAsync(async (_req, res) => {
  const { data, meta } = await HubService.list(getValidatedQuery<HubListQuery>(res));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Hubs retrieved successfully", data, meta });
});

const getById = catchAsync(async (req, res) => {
  const data = await HubService.getById(String(req.params["id"]));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Hub retrieved successfully", data });
});

const create = catchAsync(async (req, res) => {
  const data = await HubService.create(req.body as CreateHubInput, getAuthUser(req), getRequestMeta(req));
  sendResponse(res, { statusCode: httpStatus.CREATED, message: "Hub created successfully", data });
});

const update = catchAsync(async (req, res) => {
  const data = await HubService.update(
    String(req.params["id"]),
    req.body as UpdateHubInput,
    getAuthUser(req),
    getRequestMeta(req),
  );
  sendResponse(res, { statusCode: httpStatus.OK, message: "Hub updated successfully", data });
});

const remove = catchAsync(async (req, res) => {
  const data = await HubService.remove(String(req.params["id"]), getAuthUser(req), getRequestMeta(req));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Hub deleted successfully", data });
});

export const HubController = { list, getById, create, update, remove };
