import type { RequestHandler } from "express";
import multer from "multer";
import httpStatus from "http-status";
import { ApiError } from "../utils/ApiError.js";
import { MAX_IMAGE_BYTES, isAllowedImageMimeType, validateImageFile } from "../utils/imageUpload.js";

/**
 * Single image upload into MEMORY (nothing touches the disk, which Vercel
 * functions don't allow anyway). Limits stop oversized or extra parts while
 * streaming. Afterwards the bytes are checked against the declared type.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0, parts: 1, headerPairs: 100 },
  fileFilter: (_req, file, callback) => {
    if (!isAllowedImageMimeType(file.mimetype)) {
      callback(new ApiError(httpStatus.BAD_REQUEST, "Image must be JPEG, PNG or WebP", [{ path: "image", message: `Got ${file.mimetype}` }]));
      return;
    }
    callback(null, true);
  },
});

const multerMessage = (error: multer.MulterError): { status: number; message: string } => {
  switch (error.code) {
    case "LIMIT_FILE_SIZE":
      return { status: httpStatus.REQUEST_ENTITY_TOO_LARGE, message: "Image must be 4 MB or smaller" };
    case "LIMIT_FILE_COUNT":
    case "LIMIT_PART_COUNT":
    case "LIMIT_FIELD_COUNT":
      return { status: httpStatus.BAD_REQUEST, message: "Send exactly one file in the 'image' field and no other fields" };
    case "LIMIT_UNEXPECTED_FILE":
      return { status: httpStatus.BAD_REQUEST, message: "The file must be sent in the 'image' form field" };
    default:
      return { status: httpStatus.BAD_REQUEST, message: "Invalid multipart upload" };
  }
};

/** multipart/form-data with one `image` file (JPEG/PNG/WebP, ≤ 4 MB). Sets req.file. */
export const uploadSingleImage = (field: string): RequestHandler => {
  const handler = upload.single(field);
  return (req, res, next) => {
    if (!req.is("multipart/form-data")) {
      next(new ApiError(httpStatus.UNSUPPORTED_MEDIA_TYPE, "Send the image as multipart/form-data", [{ path: field, message: "Required" }]));
      return;
    }
    handler(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError) {
        const { status, message } = multerMessage(error);
        next(new ApiError(status, message, [{ path: field, message }]));
        return;
      }
      if (error) {
        next(error instanceof ApiError ? error : new ApiError(httpStatus.BAD_REQUEST, "Invalid multipart upload"));
        return;
      }
      const result = validateImageFile(req.file);
      if (!result.ok) {
        next(new ApiError(result.status, result.message, [{ path: field, message: result.message }]));
        return;
      }
      next();
    });
  };
};
