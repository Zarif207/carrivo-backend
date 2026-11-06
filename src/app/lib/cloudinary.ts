import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { env } from "../config/env.js";

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

/** Well under Vercel's function limit; the SDK aborts the HTTP request after this. */
const UPLOAD_TIMEOUT_MS = 20_000;

export const PROOF_FOLDER = "carrivo/proof-of-delivery";

export interface UploadedImage {
  url: string;
  publicId: string;
  bytes: number;
  format: string;
  width: number;
  height: number;
}

/**
 * Streams an in-memory buffer to Cloudinary (no disk writes, works on Vercel).
 * The public id is random (Cloudinary default), so the URL is unguessable.
 */
export const uploadImageBuffer = (buffer: Buffer, options: { folder: string; tags: string[] }): Promise<UploadedImage> =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder,
        resource_type: "image",
        allowed_formats: ["jpg", "png", "webp"],
        unique_filename: true,
        overwrite: false,
        tags: options.tags,
        timeout: UPLOAD_TIMEOUT_MS,
      },
      (error, result?: UploadApiResponse) => {
        if (error || !result) {
          reject(new Error(error?.message ?? "Cloudinary returned no result"));
          return;
        }
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          bytes: result.bytes,
          format: result.format,
          width: result.width,
          height: result.height,
        });
      },
    );
    stream.end(buffer);
  });

/** Deletes an image and purges CDN copies. Never throws: returns whether Cloudinary confirmed it. */
export const deleteImage = async (publicId: string): Promise<boolean> => {
  try {
    const result = (await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true })) as { result?: string };
    return result.result === "ok";
  } catch (error) {
    console.warn(`[cloudinary] delete failed for ${publicId}: ${error instanceof Error ? error.message : "unknown error"}`);
    return false;
  }
};
