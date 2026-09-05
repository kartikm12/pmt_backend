import { Router } from "express";
import { AttachmentController } from "../controllers/attachment.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { upload } from "../utils/multer.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const attachmentRouter = Router();

// All routes require authentication
attachmentRouter.use(authenticate);

attachmentRouter.post("/upload", upload.single("file"), asyncHandler(AttachmentController.upload));
attachmentRouter.get("/", asyncHandler(AttachmentController.list));
attachmentRouter.delete("/:id", asyncHandler(AttachmentController.remove));
