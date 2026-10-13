import type { Request, Response } from "express";
import { LeaderboardService } from "../services/leaderboard.service.js";

export class LeaderboardController {
  static async getSnapshot(req: Request, res: Response) {
    const parsed = parseInt(req.query.range as string, 10);
    // The UI's "ALL" button sends 999; only the start date depends on this, so a wide cap is cheap
    const days = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 3650) : 30;
    const projectId = req.query.projectId as string | undefined;

    const leaderboard = await LeaderboardService.getSnapshot({ days, projectId });
    return res.status(200).json(leaderboard);
  }
}
