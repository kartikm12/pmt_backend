import multer from "multer";
import path from "path";
import { ApiError } from "./apiError.js";
import type { NextFunction, Request, Response } from "express";

const storage = multer.memoryStorage();

const allowedMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);

const allowedExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pdf",
  ".txt",
  ".csv",
  ".ppt",
  ".pptx",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx"
]);

export const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const isAllowed = allowedMimeTypes.has(file.mimetype) && allowedExtensions.has(extension);

    if (!isAllowed) {
      cb(new ApiError(400, "Unsupported file type"));
      return;
    }

    cb(null, true);
  }
});

/**
 * FIX (HIGH #1): Magic bytes validation middleware.
 *
 * Must be placed AFTER upload.single() / upload.fields() in the route chain because
 * it operates on req.file.buffer (populated by multer memoryStorage).
 *
 * The fileFilter above is only a fast early gate based on the client-declared
 * Content-Type header, which is trivially spoofed. This middleware inspects the
 * actual binary magic bytes using the `file-type` package and rejects any file
 * whose real content type does not match what was declared.
 */
export async function validateFileBytes(req: Request, _res: Response, next: NextFunction) {
  const file = req.file;
  if (!file) return next();

  try {
    // Dynamic import — file-type is a pure-ESM package
    const { fileTypeFromBuffer } = await import("file-type");
    const detected = await fileTypeFromBuffer(file.buffer);

    // Plain text / CSV files have no binary magic bytes — skip the byte check
    const textOnlyTypes = new Set(["text/plain", "text/csv"]);
    if (textOnlyTypes.has(file.mimetype)) {
      return next();
    }

    // For all other types the detected type must be present and on the allowlist
    if (!detected || !allowedMimeTypes.has(detected.mime)) {
      return next(new ApiError(400, "File content does not match its declared type"));
    }

    // The detected MIME must agree with the client-declared MIME
    if (detected.mime !== file.mimetype) {
      return next(new ApiError(400, "File content does not match its declared type"));
    }

    next();
  } catch {
    // Fail safe: if file-type itself throws, reject the upload
    next(new ApiError(400, "Unable to verify file content"));
  }
}
