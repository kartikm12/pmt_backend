import fs from "fs";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { ZodError } from "zod";
import { ApiError } from "../utils/apiError.js";
export function notFound(_req, _res, next) {
    next(new ApiError(404, "Route not found"));
}
export function errorHandler(error, _req, res, _next) {
    if (error instanceof ApiError) {
        return res.status(error.statusCode).json({ message: error.message });
    }
    if (error instanceof ZodError) {
        return res.status(400).json({
            message: "Validation failed",
            issues: error.flatten()
        });
    }
    if (error instanceof PrismaClientKnownRequestError && error.code === "P2002") {
        return res.status(409).json({ message: "A unique constraint was violated" });
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
                    }
                    catch (unlinkErr) {
                        console.error("Failed to delete old log backup", unlinkErr);
                    }
                }
                try {
                    fs.renameSync(logFile, backupFile);
                }
                catch (renameErr) {
                    console.error("Failed to rename log file", renameErr);
                }
            }
        }
        fs.appendFileSync(logFile, logEntry);
    }
    catch (logErr) {
        console.error("Failed to write to server_error.log", logErr);
    }
    return res.status(500).json({ message: "Internal server error" });
}
