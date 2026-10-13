import type { Request, Response } from "express";
import type { UserRole } from "../constants/enums.js";
import { ActivityLogService } from "../services/activity-log.service.js";
import { ProjectService } from "../services/project.service.js";
import { TaskService } from "../services/task.service.js";

export class ActivityController {
  static async list(req: Request, res: Response) {
    const { userId, role } = req.user!;
    const projectId = req.query.projectId as string | undefined;
    const taskId = req.query.taskId as string | undefined;
    const requestedLimit = Number(req.query.limit);

    // Non-managers only see activity for tasks/projects they can open
    let scope: object | undefined;
    if (!ProjectService.isManagerRole(role as UserRole)) {
      if (taskId) {
        await TaskService.getById(taskId, userId, role as UserRole);
      } else if (projectId) {
        await ProjectService.assertProjectAccess(projectId, userId, role as UserRole);
      } else {
        scope = {
          OR: [
            { userId },
            { project: { members: { some: { userId, removedAt: null } } } },
            { task: { assignees: { some: { id: userId } } } }
          ]
        };
      }
    }

    const logs = await ActivityLogService.list({
      projectId,
      taskId,
      userId: req.query.userId as string | undefined,
      limit: Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200) : undefined,
      scope
    });

    return res.status(200).json(logs);
  }
}
