/**
 * Pure upload validation (unit-tested). The client's declared mimetype is only a
 * first filter: the file's leading bytes ("magic numbers") must match it too,
 * so a renamed .exe or an SVG labelled image/png is rejected.
 */

/**
 * 4 MB, below Vercel's 4.5 MB request-body limit, so an oversized photo always
 * gets OUR error response instead of a platform 413. Frontends should compress photos.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export const isAllowedImageMimeType = (mimetype: string): mimetype is AllowedImageMimeType =>
  (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mimetype);

const startsWith = (buffer: Buffer, bytes: number[], offset = 0): boolean =>
  buffer.length >= offset + bytes.length && bytes.every((byte, i) => buffer[offset + i] === byte);

/** Detects JPEG, PNG or WebP from the file's leading bytes; null for anything else. */
export const detectImageType = (buffer: Buffer): AllowedImageMimeType | null => {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // "RIFF" <size> "WEBP"
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
};

export interface UploadedFileLike {
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export type ImageValidationResult =
  | { ok: true; mimetype: AllowedImageMimeType }
  | { ok: false; status: 400 | 413; message: string };

export const validateImageFile = (file: UploadedFileLike | undefined): ImageValidationResult => {
  if (!file || file.size === 0 || file.buffer.length === 0) {
    return { ok: false, status: 400, message: "An image file is required in the 'image' form field" };
  }
  if (file.size > MAX_IMAGE_BYTES || file.buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, status: 413, message: "Image must be 4 MB or smaller" };
  }
  if (!isAllowedImageMimeType(file.mimetype)) {
    return { ok: false, status: 400, message: "Image must be JPEG, PNG or WebP" };
  }
  const detected = detectImageType(file.buffer);
  if (!detected) return { ok: false, status: 400, message: "File content is not a JPEG, PNG or WebP image" };
  if (detected !== file.mimetype) {
    return { ok: false, status: 400, message: `File content (${detected}) does not match its declared type (${file.mimetype})` };
  }
  return { ok: true, mimetype: detected };
};
