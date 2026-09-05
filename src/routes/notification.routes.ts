import { Router } from "express";
import { NotificationController } from "../controllers/notification.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const notificationRouter = Router();

notificationRouter.use(authenticate);

notificationRouter.get("/", asyncHandler(NotificationController.list));
notificationRouter.patch("/:id/read", asyncHandler(NotificationController.markAsRead));
notificationRouter.post("/read-all", asyncHandler(NotificationController.markAllAsRead));
notificationRouter.delete("/:id", asyncHandler(NotificationController.delete));
