import type { Request, Response } from "express";
import httpStatus from "http-status";
import { env } from "../../config/env.js";
import { sendResponse } from "../../utils/sendResponse.js";
import { RootService } from "./root.service.js";

/** GET / and GET /api/v1: what this API is and where to go next. Synchronous: nothing to await. */
const getInfo = (_req: Request, res: Response): void => {
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: "Carrivo API is running",
    data: RootService.getInfo(env.NODE_ENV, new Date()),
  });
};

export const RootController = { getInfo };
