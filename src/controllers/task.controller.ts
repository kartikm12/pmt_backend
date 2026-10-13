import type { Request, Response } from "express";
import { TaskService } from "../services/task.service.js";
import { SubtaskService } from "../services/subtask.service.js";
import { TimeEntryService } from "../services/time-entry.service.js";

export class TaskController {
  static async list(req: Request, res: Response) {
    const tasks = await TaskService.list(req.user!.userId, req.user!.role as any, req.query.projectId as string | undefined);
    return res.status(200).json(tasks);
  }

  static async getById(req: Request, res: Response) {
    const task = await TaskService.getById(req.params.taskId, req.user!.userId, req.user!.role as any);
    return res.status(200).json(task);
  }

  static async create(req: Request, res: Response) {
    const task = await TaskService.create(req.user!.userId, req.user!.role, req.body);
    return res.status(201).json(task);
  }

  static async update(req: Request, res: Response) {
    const task = await TaskService.update(req.params.taskId, req.user!.userId, req.user!.role, req.body);
    return res.status(200).json(task);
  }

  static async remove(req: Request, res: Response) {
    const result = await TaskService.remove(req.params.taskId, req.user!.userId, req.user!.role as any);
    return res.status(200).json(result);
  }

  static async restore(req: Request, res: Response) {
    return res.status(200).json(await TaskService.restore(req.params.taskId, req.user!.userId));
  }

  static async reorder(req: Request, res: Response) {
    return res.status(200).json(await TaskService.reorder(req.body, req.user!.userId, req.user!.role));
  }

  static async watch(req: Request, res: Response) {
    return res.status(200).json(await TaskService.setWatching(req.params.taskId, true, req.user!.userId, req.user!.role));
  }

  static async unwatch(req: Request, res: Response) {
    return res.status(200).json(await TaskService.setWatching(req.params.taskId, false, req.user!.userId, req.user!.role));
  }

  static async addSubtask(req: Request, res: Response) {
    return res.status(201).json(await SubtaskService.create(req.params.taskId, req.body.title, req.user!.userId, req.user!.role));
  }

  static async updateSubtask(req: Request, res: Response) {
    return res.status(200).json(await SubtaskService.update(req.params.subtaskId, req.body, req.user!.userId, req.user!.role));
  }

  static async removeSubtask(req: Request, res: Response) {
    await SubtaskService.remove(req.params.subtaskId, req.user!.userId, req.user!.role);
    return res.status(204).send();
  }

  static async logTime(req: Request, res: Response) {
    return res.status(201).json(await TimeEntryService.log(req.params.taskId, req.body, req.user!.userId, req.user!.role));
  }

  static async removeTime(req: Request, res: Response) {
    await TimeEntryService.remove(req.params.entryId, req.user!.userId, req.user!.role);
    return res.status(204).send();
  }
}
