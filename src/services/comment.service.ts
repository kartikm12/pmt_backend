import { prisma } from "../prisma/client.js";
import { ActivityService } from "./activity.service.js";
import { socketService } from "./socket.service.js";

import { NotificationService } from "./notification.service.js";
import type { UserRole } from "../constants/enums.js";
import { TaskService } from "./task.service.js";
import { ProjectService } from "./project.service.js";
import { ApiError } from "../utils/apiError.js";
import { StorageService } from "./storage.service.js";
import { withFileLink } from "../utils/fileLink.js";

export class CommentService {
  static async list(taskId: string, userId: string, role: UserRole) {
    await TaskService.access(taskId, userId, role);

    const comments = await prisma.taskComment.findMany({
      where: { taskId, deletedAt: null },
      include: {
        user: {
          select: { id: true, fullName: true, avatarUrl: true }
        },
        attachments: { orderBy: { createdAt: "asc" } }
      },
      orderBy: { createdAt: "desc" }
    });
    return comments.map((c) => ({ ...c, attachments: c.attachments.map(withFileLink) }));
  }

  static async create(taskId: string, userId: string, role: UserRole, body: string, files: Express.Multer.File[] = []) {
    const task = await TaskService.access(taskId, userId, role);
    ProjectService.checkRole(task.myRole, task.projectStatus, "contributor"); // viewers read only

    // 1. Files go to private storage first; the comment and its file rows are then saved together. If either
    //    step fails, the stored files are removed again (no orphan files, no comment pointing at missing ones)
    //    The files upload side by side (5 screenshots no longer wait for each other)
    const uploads = await Promise.allSettled(files.map((f) => StorageService.uploadPrivateFile(f.buffer, f.originalname, f.mimetype)));
    const stored = uploads.flatMap((u) => (u.status === "fulfilled" ? [u.value] : []));
    let comment;
    try {
      const failed = uploads.find((u): u is PromiseRejectedResult => u.status === "rejected");
      if (failed) throw failed.reason;
      // 2. Saved and read back in one go: everything the notifications and the reply need comes with it
      comment = await prisma.taskComment.create({
        data: {
          taskId, userId, body,
          attachments: { create: files.map((f, i) => ({ name: f.originalname, url: stored[i], fileType: f.mimetype, fileSize: f.size, projectId: task.projectId, taskId, userId })) }
        },
        include: {
          user: { select: { id: true, fullName: true, avatarUrl: true } },
          attachments: { orderBy: { createdAt: "asc" } },
          task: {
            include: {
              assignees: { select: { id: true } },
              watchers: { select: { id: true } }
            }
          }
        }
      });
    } catch (err) {
      await Promise.all(stored.map((ref) => StorageService.deleteFile(ref)));
      throw err;
    }

    // Side effects (Notifications, Activity) wrapped in try-catch
    try {
      // Activity Log and the mention look-up don't depend on each other: they go out together
      const activity = ActivityService.log({
        action: "COMMENT_ADDED",
        entityType: "task",
        entityId: taskId,
        description: [
          body ? `Comment: "${body.length > 50 ? body.substring(0, 47) + "..." : body}"` : "Comment",
          files.length ? `with ${files.length} file${files.length > 1 ? "s" : ""}` : ""
        ].filter(Boolean).join(" "),
        userId,
        projectId: comment.task.projectId,
        taskId
      }).catch(err => console.error("Activity log failed:", err));

      // Mentions logic
      // Only people who can open this task: company managers, project members and its assignees; never suspended
      const [allUsers] = await Promise.all([prisma.user.findMany({
        select: { id: true, fullName: true },
        where: {
          deletedAt: null, pendingApproval: false, status: { not: "SUSPENDED" },
          OR: [
            { role: { in: ["MANAGER", "PROJECT_MANAGER", "ADMIN"] } },
            { memberships: { some: { projectId: comment.task.projectId, removedAt: null } } },
            { assignedTasks: { some: { id: taskId } } }
          ]
        }
      }), activity]);
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
        ...comment.task.watchers.map(w => w.id),
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
          taskId: comment.task.id,
          // Only real @mentions are emailed; every comment would be too many emails
          email: isMentioned
        }).catch(err => console.error(`Notification failed for ${targetId}:`, err));

        socketService.emitToUser(targetId, "comment_added", {
          taskId,
          commentId: comment.id,
          isMention: isMentioned
        });
      }

      // Project-wide real-time event (and each file, so an open Files tab shows it)
      socketService.emitToProject(comment.task.projectId, "comment_added", {
        taskId,
        comment: {
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt,
          user: comment.user,
          attachments: comment.attachments.map(withFileLink)
        }
      });
      for (const a of comment.attachments) socketService.emitToProject(comment.task.projectId, "attachment_added", withFileLink(a));
    } catch (sideEffectError) {
      console.error("Comment side effects failed:", sideEffectError);
    }

    return { ...comment, attachments: comment.attachments.map(withFileLink) };
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

    if (!comment || comment.deletedAt) {
      throw new ApiError(404, "Comment not found");
    }

    const task = await TaskService.access(comment.task.id, userId, role);

    // Managers of this project can delete any comment (moderation); others only their own
    ProjectService.assertOpenStatus(task.projectStatus);
    const isManager = task.myRole === "manager";

    if (!isManager && comment.userId !== userId) {
      throw new ApiError(403, "You do not have permission to delete this comment");
    }

    // Its files go with it: rows first, then storage (a storage hiccup leaves a spare file, never a broken row)
    const files = await prisma.attachment.findMany({ where: { commentId }, select: { id: true, url: true } });
    const [removed] = await prisma.$transaction([
      prisma.taskComment.update({ where: { id: commentId }, data: { deletedAt: new Date() } }),
      prisma.attachment.deleteMany({ where: { commentId } })
    ]);
    for (const f of files) {
      await StorageService.deleteFile(f.url);
      socketService.emitToProject(task.projectId, "attachment_deleted", { id: f.id, taskId: task.id });
    }
    return removed;
  }

  // Only the author may reword a comment; managers can delete any comment but not put words in someone's mouth
  static async update(commentId: string, userId: string, role: UserRole, body: string) {
    const comment = await prisma.taskComment.findFirst({
      where: { id: commentId, deletedAt: null },
      select: { userId: true, taskId: true, _count: { select: { attachments: true } } }
    });
    if (!comment) {
      throw new ApiError(404, "Comment not found");
    }
    // The text may go only if the comment still has files to show
    if (!body.trim() && !comment._count.attachments) throw new ApiError(400, "Comment cannot be empty");

    const task = await TaskService.access(comment.taskId, userId, role);
    if (comment.userId !== userId) {
      throw new ApiError(403, "You can only edit your own comments");
    }
    ProjectService.assertOpenStatus(task.projectStatus);

    const updated = await prisma.taskComment.update({
      where: { id: commentId },
      data: { body },
      include: { user: { select: { id: true, fullName: true, avatarUrl: true } } }
    });

    socketService.emitToProject(task.projectId, "comment_updated", {
      taskId: comment.taskId,
      comment: { id: updated.id, body: updated.body, updatedAt: updated.updatedAt }
    });

    return updated;
  }
}
