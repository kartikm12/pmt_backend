import { Router } from "express";
import { ActivityController } from "../controllers/activity.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
export const activityRouter = Router();
activityRouter.use(authenticate);
activityRouter.get("/", asyncHandler(ActivityController.list));
