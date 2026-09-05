import type { Request, Response } from "express";
import { DashboardService } from "../services/dashboard.service.js";
import { ReportsService } from "../services/reports.service.js";

export class DashboardController {
  static async getStats(req: Request, res: Response) {
    const stats = await DashboardService.getStats(req.user!.userId, req.user!.role as any);
    return res.status(200).json(stats);
  }
}

export class ReportsController {
  static async getTrends(req: Request, res: Response) {
    const days = parseInt(req.query.days as string) || 7;
    const projectId = req.query.projectId as string | undefined;
    const memberId = req.query.memberId as string | undefined;

    const trends = await ReportsService.getComprehensiveReport(
      req.user!.userId, 
      req.user!.role as string, 
      { days, projectId, memberId }
    );
    return res.status(200).json(trends);
  }
}
