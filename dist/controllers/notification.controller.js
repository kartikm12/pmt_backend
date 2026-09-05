import { NotificationService } from "../services/notification.service.js";
export class NotificationController {
    static async list(req, res) {
        const notifications = await NotificationService.list(req.user.userId);
        return res.status(200).json(notifications);
    }
    static async markAsRead(req, res) {
        const { id } = req.params;
        const notification = await NotificationService.markAsRead(id, req.user.userId);
        return res.status(200).json(notification);
    }
    static async markAllAsRead(req, res) {
        const result = await NotificationService.markAllAsRead(req.user.userId);
        return res.status(200).json(result);
    }
    static async delete(req, res) {
        const { id } = req.params;
        await NotificationService.delete(id, req.user.userId);
        return res.status(204).send();
    }
}
