import { Router } from "express";
import { DashboardController, ReportsController } from "../controllers/stats.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { asyncHandler } from "../utils/asyncHandler.js";
export const statsRouter = Router();
statsRouter.use(authenticate);
statsRouter.get("/dashboard", asyncHandler(DashboardController.getStats));
statsRouter.get("/reports", asyncHandler(ReportsController.getTrends));
