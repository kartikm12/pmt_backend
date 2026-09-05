import { Router } from "express";
import { LeaderboardController } from "../controllers/leaderboard.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const leaderboardRouter = Router();

leaderboardRouter.use(authenticate);
leaderboardRouter.get("/", asyncHandler(LeaderboardController.getSnapshot));
