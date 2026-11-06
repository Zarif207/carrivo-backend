import httpStatus from "http-status";
import { getAuthUser } from "../../middlewares/authenticate.js";
import { getValidatedQuery } from "../../middlewares/validateRequest.js";
import { catchAsync } from "../../utils/catchAsync.js";
import { getRequestMeta } from "../../utils/requestMeta.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { ShipmentService } from "./shipment.service.js";
import type {
  AssignInput,
  CancelShipmentInput,
  CreateShipmentInput,
  PickupInput,
  ShipmentListQuery,
  UnassignInput,
  UpdateShipmentInput,
  UpdateStatusInput,
} from "./shipment.validation.js";

const create = catchAsync(async (req, res) => {
  const data = await ShipmentService.create(getAuthUser(req), req.body as CreateShipmentInput, getRequestMeta(req));
  sendResponse(res, { statusCode: httpStatus.CREATED, message: "Shipment created successfully", data });
});

const list = catchAsync(async (req, res) => {
  const { data, meta } = await ShipmentService.list(getAuthUser(req), getValidatedQuery<ShipmentListQuery>(res));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Shipments retrieved successfully", data, meta });
});

const getById = catchAsync(async (req, res) => {
  const data = await ShipmentService.getById(getAuthUser(req), String(req.params["id"]));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Shipment retrieved successfully", data });
});

const update = catchAsync(async (req, res) => {
  const data = await ShipmentService.update(
    getAuthUser(req),
    String(req.params["id"]),
    req.body as UpdateShipmentInput,
    getRequestMeta(req),
  );
  sendResponse(res, { statusCode: httpStatus.OK, message: "Shipment updated successfully", data });
});

const cancel = catchAsync(async (req, res) => {
  const body = req.body as CancelShipmentInput;
  const data = await ShipmentService.cancel(
    getAuthUser(req),
    String(req.params["id"]),
    body?.reason,
    getRequestMeta(req),
  );
  sendResponse(res, { statusCode: httpStatus.OK, message: "Shipment cancelled successfully", data });
});

const remove = catchAsync(async (req, res) => {
  const data = await ShipmentService.remove(getAuthUser(req), String(req.params["id"]), getRequestMeta(req));
  sendResponse(res, { statusCode: httpStatus.OK, message: "Shipment deleted successfully", data });
});

const schedulePickup = catchAsync(async (req, res) => {
  const data = await ShipmentService.schedulePickup(
    getAuthUser(req),
    String(req.params["id"]),
    req.body as PickupInput,
    getRequestMeta(req),
  );
  sendResponse(res, { statusCode: httpStatus.OK, message: "Pickup scheduled successfully", data });
});

const assign = catchAsync(async (req, res) => {
  const data = await ShipmentService.assignCourier(
    getAuthUser(req),
    String(req.params["id"]),
    req.body as AssignInput,
    getRequestMeta(req),
  );
  sendResponse(res, { statusCode: httpStatus.OK, message: "Courier assigned successfully", data });
});

const unassign = catchAsync(async (req, res) => {
  const data = await ShipmentService.unassignCourier(
    getAuthUser(req),
    String(req.params["id"]),
    req.body as UnassignInput,
    getRequestMeta(req),
  );
  sendResponse(res, { statusCode: httpStatus.OK, message: "Courier unassigned successfully", data });
});

const updateStatus = catchAsync(async (req, res) => {
  const data = await ShipmentService.updateStatus(
    getAuthUser(req),
    String(req.params["id"]),
    req.body as UpdateStatusInput,
    getRequestMeta(req),
  );
  sendResponse(res, { statusCode: httpStatus.OK, message: "Shipment status updated successfully", data });
});

export const ShipmentController = {
  create,
  list,
  getById,
  update,
  cancel,
  remove,
  schedulePickup,
  assign,
  unassign,
  updateStatus,
};
