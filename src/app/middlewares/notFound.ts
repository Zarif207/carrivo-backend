import type { RequestHandler } from "express";
import httpStatus from "http-status";
import type { ErrorResponse } from "../types/response.types.js";

export const notFound: RequestHandler = (req, res) => {
  const body: ErrorResponse = {
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
    errors: [],
  };
  res.status(httpStatus.NOT_FOUND).json(body);
};
