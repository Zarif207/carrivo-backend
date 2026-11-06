import httpStatus from "http-status";
import { getAuthUser } from "../../middlewares/authenticate.js";
import { getValidatedQuery } from "../../middlewares/validateRequest.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { getRequestMeta } from "../../utils/requestMeta.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { PricingService } from "./pricing.service.js";
import type {
  CreatePricingRuleInput,
  EstimateInput,
  PricingListQuery,
  UpdatePricingRuleInput,
} from "./pricing.validation.js";

const estimate = catchAsync(async (req, res) => {
  const data = await PricingService.estimate(req.body as EstimateInput);
  sendResponse(res, { statusCode: httpStatus.OK, message: "Price estimated successfully", data });
});

const list = catchAsync(async (_req, res) => {
  const { data, meta } = await PricingService.list(getValidatedQuery<PricingListQuery>(res));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Pricing rules retrieved successfully", data, meta });
});

const getById = catchAsync(async (req, res) => {
  const data = await PricingService.getById(String(req.params["id"]));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Pricing rule retrieved successfully", data });
});

const create = catchAsync(async (req, res) => {
  const data = await PricingService.create(req.body as CreatePricingRuleInput, getAuthUser(req), getRequestMeta(req));
  sendResponse(res, { statusCode: httpStatus.CREATED, message: "Pricing rule created successfully", data });
});

const update = catchAsync(async (req, res) => {
  const data = await PricingService.update(
    String(req.params["id"]),
    req.body as UpdatePricingRuleInput,
    getAuthUser(req),
    getRequestMeta(req),
  );
  sendResponse(res, { statusCode: httpStatus.OK, message: "Pricing rule updated successfully", data });
});

const remove = catchAsync(async (req, res) => {
  const data = await PricingService.remove(String(req.params["id"]), getAuthUser(req), getRequestMeta(req));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Pricing rule deleted successfully", data });
});

export const PricingController = { estimate, list, getById, create, update, remove };
