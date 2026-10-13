import { Router } from "express";
import { USER_ROLE } from "../constants/enums.js";
import { DashboardController, ReportsController } from "../controllers/stats.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { SearchService } from "../services/search.service.js";

export const statsRouter = Router();

statsRouter.use(authenticate);
statsRouter.get("/dashboard", asyncHandler(DashboardController.getStats));
statsRouter.get("/reports", asyncHandler(ReportsController.getTrends));
statsRouter.get(
  "/workload",
  authorize(USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN),
  asyncHandler(async (_req, res) => {
    res.status(200).json(await SearchService.workload());
  })
);
