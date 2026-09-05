import { LeaderboardService } from "../services/leaderboard.service.js";
export class LeaderboardController {
    static async getSnapshot(req, res) {
        const days = req.query.range ? parseInt(req.query.range) : 30;
        const projectId = req.query.projectId;
        const leaderboard = await LeaderboardService.getSnapshot({ days, projectId });
        return res.status(200).json(leaderboard);
    }
}
