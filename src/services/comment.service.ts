import { prisma } from "../prisma/client.js";
import { ActivityService } from "./activity.service.js";
import { socketService } from "./socket.service.js";

import { NotificationService } from "./notification.service.js";
import type { UserRole } from "../constants/enums.js";
import { TaskService } from "./task.service.js";
import { ApiError } from "../utils/apiError.js";

export class CommentService {
  static async list(taskId: string, userId: string, role: UserRole) {
    await TaskService.getById(taskId, userId, role);

    return prisma.taskComment.findMany({
      where: { taskId, deletedAt: null },
      include: {
        user: {
          select: { id: true, fullName: true, avatarUrl: true }
        }
      },
      orderBy: { createdAt: "desc" }
    });
  }

  static async create(taskId: string, userId: string, role: UserRole, body: string) {
    await TaskService.getById(taskId, userId, role);

    // 1. Create the comment
    const commentRecord = await prisma.taskComment.create({
      data: { taskId, userId, body }
    });

    // 2. Fetch required data for notifications/activity in a separate, simple query
    // We do this separately to avoid complex nested includes that can fail
    const comment = await prisma.taskComment.findUnique({
      where: { id: commentRecord.id },
      include: {
        user: { select: { id: true, fullName: true, avatarUrl: true } },
        task: {
          include: {
            assignees: { select: { id: true } }
          }
        }
      }
    });

    if (!comment) throw new Error("Failed to retrieve created comment");

    // Side effects (Notifications, Activity) wrapped in try-catch
    try {
      // Activity Log
      await ActivityService.log({
        action: "COMMENT_ADDED",
        entityType: "task",
        entityId: taskId,
        description: `Comment: "${body.length > 50 ? body.substring(0, 47) + "..." : body}"`,
        userId,
        projectId: comment.task.projectId,
        taskId
      }).catch(err => console.error("Activity log failed:", err));

      // Mentions logic
      const allUsers = await prisma.user.findMany({ select: { id: true, fullName: true }, where: { deletedAt: null } });
      // Sort users by length of fullName descending to avoid partial matches
      allUsers.sort((a, b) => b.fullName.length - a.fullName.length);
      
      const mentionedUsers = allUsers.filter(u => {
        // Strip multiple spaces to handle UI mismatch and make it case-insensitive
        const cleanBody = body.replace(/\s+/g, ' ');
        const cleanName = u.fullName.replace(/\s+/g, ' ');
        const escapedName = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`@${escapedName}(?!\\w)`, 'i');
        return regex.test(cleanBody);
      });

      // Notifications
      const notifyUserIds = new Set([
        ...comment.task.assignees.map(a => a.id),
        ...mentionedUsers.map(u => u.id)
      ]);

      for (const targetId of notifyUserIds) {
        if (targetId === userId) continue;
        const isMentioned = mentionedUsers.some(u => u.id === targetId);
        
        NotificationService.create({
          userId: targetId,
          type: isMentioned ? "COMMENT_MENTION" : "TASK_ASSIGNED",
          title: isMentioned ? "Mentioned in Comment" : "New Comment",
          message: isMentioned 
            ? `${comment.user?.fullName || "A user"} mentioned you in a comment on task: ${comment.task.title}`
            : `${comment.user?.fullName || "A user"} commented on task: ${comment.task.title}`,
          projectId: comment.task.projectId,
          taskId: comment.task.id
        }).catch(err => console.error(`Notification failed for ${targetId}:`, err));

        socketService.emitToUser(targetId, "comment_added", {
          taskId,
          commentId: comment.id,
          isMention: isMentioned
        });
      }

      // Project-wide real-time event
      socketService.emitToProject(comment.task.projectId, "comment_added", {
        taskId,
        comment: {
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt,
          user: comment.user
        }
      });
    } catch (sideEffectError) {
      console.error("Comment side effects failed:", sideEffectError);
    }

    return comment;
  }

  static async remove(commentId: string, userId: string, role: UserRole) {
    const comment = await prisma.taskComment.findUnique({
      where: { id: commentId },
      include: {
        task: {
          select: { id: true }
        }
      }
    });

    if (!comment) {
      throw new ApiError(404, "Comment not found");
    }

    await TaskService.getById(comment.task.id, userId, role);

    if (comment.userId !== userId) {
      throw new ApiError(403, "You do not have permission to delete this comment");
    }

    return prisma.taskComment.update({
      where: { id: commentId },
      data: { deletedAt: new Date() }
    });
  }
}
