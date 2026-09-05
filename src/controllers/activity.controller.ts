import type { Request, Response } from "express";
import { ActivityLogService } from "../services/activity-log.service.js";

export class ActivityController {
  static async list(req: Request, res: Response) {
    const logs = await ActivityLogService.list({
      projectId: req.query.projectId as string | undefined,
      taskId: req.query.taskId as string | undefined,
      userId: req.query.userId as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined
    });

    return res.status(200).json(logs);
  }
}
