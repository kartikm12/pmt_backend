import { prisma } from "../prisma/client.js";
import { NotificationType } from "@prisma/client";
import { socketService } from "./socket.service.js";

export class NotificationService {
  static async list(userId: string) {
    return prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: {
        project: { select: { id: true, name: true } },
        task: { select: { id: true, title: true } }
      }
    });
  }

  static async markAsRead(id: string, userId: string) {
    return prisma.notification.update({
      where: { id, userId },
      data: { isRead: true, readAt: new Date() }
    });
  }

  static async markAllAsRead(userId: string) {
    return prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() }
    });
  }

  static async create(data: {
    userId: string;
    type: NotificationType;
    title: string;
    message: string;
    projectId?: string;
    taskId?: string;
  }) {
    const notification = await prisma.notification.create({
      data
    });

    // Emit Real-Time Event
    socketService.emitToUser(data.userId, "notification", {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      projectId: notification.projectId,
      taskId: notification.taskId,
      createdAt: notification.createdAt,
      isRead: false
    });

    return notification;
  }

  static async delete(id: string, userId: string) {
    return prisma.notification.delete({
      where: { id, userId }
    });
  }
}
