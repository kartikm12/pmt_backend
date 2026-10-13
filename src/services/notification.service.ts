import { MailService } from "../mail/mail.service.js";
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

  static async create(input: {
    userId: string;
    type: NotificationType;
    title: string;
    message: string;
    projectId?: string;
    taskId?: string;
    // Also email it (sent in the background; the person can turn these off in Settings)
    email?: boolean;
    emailLink?: string;
  }) {
    const { email, emailLink, ...data } = input;
    const notification = await prisma.notification.create({
      data
    });

    if (email) {
      const link = data.taskId ? `/tasks/${data.taskId}` : data.projectId ? `/projects/${data.projectId}` : emailLink ?? "/";
      MailService.notify(data.userId, {
        subject: data.title,
        heading: data.title,
        body: data.message,
        button: { label: data.taskId ? "Open the task" : data.projectId ? "Open the project" : "Open PMT", url: MailService.appUrl(link) }
      });
    }

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
