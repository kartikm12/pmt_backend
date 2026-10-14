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
        // Not a member (only assigned a task): just their own actions and their own tasks' activity
        if (!(await ProjectService.isMember(projectId, userId, role as UserRole))) {
          scope = { OR: [{ userId }, { task: { assignees: { some: { id: userId } } } }] };
        }
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

    // Audit-log filters: date range, action type and paging
    const from = typeof req.query.from === "string" ? new Date(req.query.from) : undefined;
    const to = typeof req.query.to === "string" ? new Date(req.query.to) : undefined;
    const action = typeof req.query.action === "string" && /^[A-Z_]{3,40}$/.test(req.query.action) ? req.query.action : undefined;
    const skip = Math.max(Math.trunc(Number(req.query.skip)) || 0, 0);
    const range = {
      ...(from && !isNaN(+from) ? { gte: from } : {}),
      ...(to && !isNaN(+to) ? { lte: to } : {})
    };

    const logs = await ActivityLogService.list({
      projectId,
      taskId,
      userId: req.query.userId as string | undefined,
      limit: Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500) : undefined,
      skip,
      scope: { ...scope, ...(Object.keys(range).length ? { createdAt: range } : {}), ...(action ? { action } : {}) }
    });

    return res.status(200).json(logs);
  }
}
