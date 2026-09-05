import type { Request, Response } from "express";
import { LeaderboardService } from "../services/leaderboard.service.js";

export class LeaderboardController {
  static async getSnapshot(req: Request, res: Response) {
    const days = req.query.range ? parseInt(req.query.range as string) : 30;
    const projectId = req.query.projectId as string | undefined;

    const leaderboard = await LeaderboardService.getSnapshot({ days, projectId });
    return res.status(200).json(leaderboard);
  }
}
