import fs from "fs";
import multer from "multer";
import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
// Must be the class the client actually throws; the runtime/library import is a separate copy under ESM,
// so `instanceof` against it never matched and every Prisma error became a 500
const { PrismaClientKnownRequestError } = Prisma;
import { ZodError } from "zod";
import { ApiError } from "../utils/apiError.js";

export function notFound(_req: Request, _res: Response, next: NextFunction) {
  next(new ApiError(404, "Route not found"));
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (error instanceof ApiError) {
    return res.status(error.statusCode).json({ message: error.message });
  }

  if (error instanceof ZodError) {
    return res.status(400).json({
      message: "Validation failed",
      issues: error.flatten()
    });
  }

  // body-parser marks client mistakes (malformed JSON, body too large) with expose + a 4xx status
  const httpError = error as { status?: number; expose?: boolean; type?: string };
  if (httpError?.expose && typeof httpError.status === "number" && httpError.status < 500) {
    const message =
      httpError.type === "entity.parse.failed" ? "Request body is not valid JSON"
      : httpError.type === "entity.too.large" ? "Request body is too large"
      : "Bad request";
    return res.status(httpError.status).json({ message });
  }

  if (error instanceof PrismaClientKnownRequestError && error.code === "P2002") {
    return res.status(409).json({ message: "A unique constraint was violated" });
  }

  // Record missing (e.g. stale notification id) or pointing at a user/project that doesn't exist
  if (error instanceof PrismaClientKnownRequestError && error.code === "P2025") {
    return res.status(404).json({ message: "Record not found" });
  }

  if (error instanceof PrismaClientKnownRequestError && error.code === "P2003") {
    return res.status(400).json({ message: "A referenced record does not exist" });
  }

  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE" ? "File is too large (max 10 MB)" : error.message;
    return res.status(400).json({ message });
  }

  console.error(error);
  
  // Custom logging for remote debugging with auto log rotation (max 5MB)
  try {
    const logFile = "server_error.log";
    const logEntry = `[${new Date().toISOString()}] ERROR: ${error instanceof Error ? error.stack : JSON.stringify(error)}\n`;
    
    if (fs.existsSync(logFile)) {
      const stats = fs.statSync(logFile);
      const maxSizeBytes = 5 * 1024 * 1024; // 5MB limit
      if (stats.size > maxSizeBytes) {
        const backupFile = "server_error.log.old";
        if (fs.existsSync(backupFile)) {
          try {
            fs.unlinkSync(backupFile);
          } catch (unlinkErr) {
            console.error("Failed to delete old log backup", unlinkErr);
          }
        }
        try {
          fs.renameSync(logFile, backupFile);
        } catch (renameErr) {
          console.error("Failed to rename log file", renameErr);
        }
      }
    }
    
    fs.appendFileSync(logFile, logEntry);
  } catch (logErr) {
    console.error("Failed to write to server_error.log", logErr);
  }

  return res.status(500).json({ message: "Internal server error" });
}
