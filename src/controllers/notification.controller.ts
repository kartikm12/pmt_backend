import type { Request, Response } from "express";
import { NotificationService } from "../services/notification.service.js";
import { ApiError } from "../utils/apiError.js";

export class NotificationController {
  static async list(req: Request, res: Response) {
    const notifications = await NotificationService.list(req.user!.userId);
    return res.status(200).json(notifications);
  }

  static async markAsRead(req: Request, res: Response) {
    const { id } = req.params;
    const notification = await NotificationService.markAsRead(id, req.user!.userId);
    return res.status(200).json(notification);
  }

  static async markAllAsRead(req: Request, res: Response) {
    const result = await NotificationService.markAllAsRead(req.user!.userId);
    return res.status(200).json(result);
  }

  static async delete(req: Request, res: Response) {
    const { id } = req.params;
    await NotificationService.delete(id, req.user!.userId);
    return res.status(204).send();
  }
}
