import type { Request, Response } from "express";
import { ProjectService } from "../services/project.service.js";
import type { UserRole } from "../constants/enums.js";
import { LeaderboardService } from "../services/leaderboard.service.js";

export class LeaderboardController {
  static async getSnapshot(req: Request, res: Response) {
    const parsed = parseInt(req.query.range as string, 10);
    // The UI's "ALL" button sends 999; only the start date depends on this, so a wide cap is cheap
    const days = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 3650) : 30;
    const projectId = req.query.projectId as string | undefined;
    // A project's leaderboard is only for people who can open that project
    if (projectId) await ProjectService.assertProjectAccess(projectId, req.user!.userId, req.user!.role as UserRole);

    const leaderboard = await LeaderboardService.getSnapshot({ days, projectId });
    return res.status(200).json(leaderboard);
  }
}
