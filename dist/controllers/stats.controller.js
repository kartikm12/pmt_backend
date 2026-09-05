import { DashboardService } from "../services/dashboard.service.js";
import { ReportsService } from "../services/reports.service.js";
export class DashboardController {
    static async getStats(req, res) {
        const stats = await DashboardService.getStats(req.user.userId, req.user.role);
        return res.status(200).json(stats);
    }
}
export class ReportsController {
    static async getTrends(req, res) {
        const days = parseInt(req.query.days) || 7;
        const projectId = req.query.projectId;
        const memberId = req.query.memberId;
        const trends = await ReportsService.getComprehensiveReport(req.user.userId, req.user.role, { days, projectId, memberId });
        return res.status(200).json(trends);
    }
}
