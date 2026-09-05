import type { Request, Response } from "express";
import { TaskService } from "../services/task.service.js";

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
    const task = await TaskService.create(req.user!.userId, req.body);
    return res.status(201).json(task);
  }

  static async update(req: Request, res: Response) {
    const task = await TaskService.update(req.params.taskId, req.user!.userId, req.user!.role, req.body);
    return res.status(200).json(task);
  }

  static async remove(req: Request, res: Response) {
    const result = await TaskService.remove(req.params.taskId, req.user!.userId);
    return res.status(200).json(result);
  }
}
