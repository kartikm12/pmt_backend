import type { Request, Response } from "express";
import { LeaderboardService } from "../services/leaderboard.service.js";

export class LeaderboardController {
  static async getSnapshot(req: Request, res: Response) {
    const parsed = parseInt(req.query.range as string, 10);
    const days = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 365) : 30;
    const projectId = req.query.projectId as string | undefined;

    const leaderboard = await LeaderboardService.getSnapshot({ days, projectId });
    return res.status(200).json(leaderboard);
  }
}
