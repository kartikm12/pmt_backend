import { ActivityLogService } from "../services/activity-log.service.js";
export class ActivityController {
    static async list(req, res) {
        const logs = await ActivityLogService.list({
            projectId: req.query.projectId,
            taskId: req.query.taskId,
            userId: req.query.userId,
            limit: req.query.limit ? Number(req.query.limit) : undefined
        });
        return res.status(200).json(logs);
    }
}
