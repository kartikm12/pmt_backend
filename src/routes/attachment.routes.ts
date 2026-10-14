import { Router } from "express";
import { AttachmentController } from "../controllers/attachment.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { upload, validateFileBytes } from "../utils/multer.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const attachmentRouter = Router();

// Before sign-in: opened from a plain link, checked by the link's own signature (utils/fileLink.ts)
attachmentRouter.get("/:id/file", asyncHandler(AttachmentController.file));

// All other routes require authentication
attachmentRouter.use(authenticate);

attachmentRouter.post("/upload", upload.single("file"), asyncHandler(validateFileBytes), asyncHandler(AttachmentController.upload));
attachmentRouter.get("/", asyncHandler(AttachmentController.list));
attachmentRouter.delete("/:id", asyncHandler(AttachmentController.remove));
