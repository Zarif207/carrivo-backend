import type { Response } from "express";
import type { PaginationMeta, SuccessResponse } from "../types/response.types.js";

interface SendResponsePayload<T> {
  statusCode: number;
  message: string;
  data: T;
  meta?: PaginationMeta;
}

export const sendResponse = <T>(res: Response, payload: SendResponsePayload<T>): void => {
  const body: SuccessResponse<T> = {
    success: true,
    message: payload.message,
    data: payload.data,
    ...(payload.meta ? { meta: payload.meta } : {}),
  };
  res.status(payload.statusCode).json(body);
};
