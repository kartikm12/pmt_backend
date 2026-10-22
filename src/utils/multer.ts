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
  // Browsers send file names as UTF-8; multer's default (latin1) turned "रिपोर्ट.pdf" or an emoji into mojibake
  defParamCharset: "utf8",
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
  // One file (attachments) or several (a comment's files): each is checked; with several, the message names it
  const single = req.file;
  const files = single ? [single] : Array.isArray(req.files) ? req.files : [];
  for (const file of files) {
    const reason = await fileProblem(file);
    if (reason) return next(new ApiError(400, single ? reason : `"${file.originalname}": ${reason}`));
  }
  next();
}

// Why a file is refused (null when it's fine)
async function fileProblem(file: Express.Multer.File): Promise<string | null> {
  if (!file.size) return "The file is empty";
  try {
    // Dynamic import — file-type is a pure-ESM package
    const { fileTypeFromBuffer } = await import("file-type");
    const detected = await fileTypeFromBuffer(file.buffer);

    // .txt/.csv have no magic bytes, so go by extension (Windows browsers send .csv as application/vnd.ms-excel);
    // anything that *does* carry a binary signature is not really text
    const extension = path.extname(file.originalname).toLowerCase();
    if (extension === ".txt" || extension === ".csv") {
      return detected ? "File content does not match its declared type" : null;
    }

    // Legacy Office files (.doc/.xls/.ppt) all share one container signature
    const legacyOffice = new Set(["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"]);
    if (detected?.mime === "application/x-cfb" && legacyOffice.has(file.mimetype)) return null;

    // For all other types the detected type must be present, on the allowlist, and agree with what was declared
    if (!detected || !allowedMimeTypes.has(detected.mime) || detected.mime !== file.mimetype) {
      return "File content does not match its declared type";
    }
    return null;
  } catch {
    // Fail safe: if file-type itself throws, reject the upload
    return "Unable to verify file content";
  }
}
