import { prisma } from "../prisma/client.js";
import { withFileLink } from "../utils/fileLink.js";
import { socketService } from "./socket.service.js";

import { NotificationService } from "./notification.service.js";
import type { UserRole } from "../constants/enums.js";
import { ApiError } from "../utils/apiError.js";
import { ProjectService } from "./project.service.js";
import { TaskService } from "./task.service.js";

export class AttachmentService {
  static async assertAttachmentAccess(input: {
    projectId?: string | null;
    taskId?: string | null;
    userId: string;
    role: UserRole;
  }) {
    if (input.taskId) {
      await TaskService.getById(input.taskId, input.userId, input.role);
      return;
    }

    if (input.projectId) {
      await ProjectService.assertProjectAccess(input.projectId, input.userId, input.role);
      return;
    }

    throw new ApiError(400, "Attachment must belong to a project or task");
  }

  // Before anything reaches storage: the uploader needs at least contributor rights in the project.
  // Returns the project the file belongs to (a task's file always belongs to the task's own project).
  static async assertCanUpload(input: { projectId?: string; taskId?: string; userId: string; role: UserRole }) {
    let projectId = input.projectId;
    if (input.taskId) {
      projectId = (await TaskService.getById(input.taskId, input.userId, input.role)).projectId;
    }
    if (!projectId) throw new ApiError(400, "Attachment must belong to a project or task");
    await ProjectService.requireProjectRole(projectId, input.userId, input.role, "contributor");
    return projectId;
  }

  static async list(filters: { projectId?: string; taskId?: string; userId: string; role: UserRole }) {
    await this.assertAttachmentAccess(filters);
    // Same rule as the project page: non-members only see files of tasks assigned to them
    const projectScope = filters.projectId && !(await ProjectService.isMember(filters.projectId, filters.userId, filters.role))
      ? { task: { deletedAt: null, assignees: { some: { id: filters.userId } } } }
      : { OR: [{ taskId: null }, { task: { deletedAt: null } }] };

    const files = await prisma.attachment.findMany({
      where: filters.taskId 
        ? { taskId: filters.taskId } 
        : { projectId: filters.projectId || undefined, ...projectScope },
      include: {
        user: {
          select: { id: true, fullName: true, avatarUrl: true }
        }
      },
      orderBy: { createdAt: "desc" }
    });
    return files.map(withFileLink);
  }

  static async create(data: {
    name: string;
    url: string;
    fileType: string;
    fileSize: number;
    projectId?: string;
    taskId?: string;
    userId: string;
    role: UserRole;
  }) {
    await this.assertAttachmentAccess(data);
    const { role: _role, ...attachmentData } = data;

    const attachment = await prisma.attachment.create({
      data: attachmentData,
      include: {
        user: {
          select: { id: true, fullName: true, avatarUrl: true }
        },
        task: {
          include: { assignees: { select: { id: true } } }
        },
        project: {
          include: { members: { where: { removedAt: null }, select: { userId: true } } }
        }
      }
    });

    if (attachment.projectId) {
      socketService.emitToProject(attachment.projectId, "attachment_added", withFileLink(attachment));
    }

    const { project, task, user } = attachment;

    // Determine who to notify
    let notifyUserIds = new Set<string>();

    if (task && task.assignees) {
      task.assignees.forEach(a => notifyUserIds.add(a.id));
    } else if (project && project.members) {
      project.members.forEach(m => notifyUserIds.add(m.userId));
    }

    // Dispatch notifications
    for (const stakeholderId of notifyUserIds) {
      if (stakeholderId !== data.userId) {
        await NotificationService.create({
          userId: stakeholderId,
          type: "SYSTEM",
          title: "New Attachment",
          message: `${user.fullName} attached a file: ${attachment.name}`,
          projectId: attachment.projectId ?? undefined,
          taskId: attachment.taskId ?? undefined
        });
      }
    }

    return attachment;
  }

  static async delete(id: string, userId: string, role: UserRole) {
    const attachment = await this.getById(id);
    if (!attachment) throw new ApiError(404, "Attachment not found");

    await this.assertAttachmentAccess({
      projectId: attachment.projectId,
      taskId: attachment.taskId,
      userId,
      role
    });

    if (attachment.projectId) await ProjectService.assertProjectOpen(attachment.projectId);
    const projectRole = attachment.projectId ? await ProjectService.projectRole(attachment.projectId, userId, role) : null;
    if (projectRole !== "manager" && attachment.userId !== userId) {
      throw new ApiError(403, "You do not have permission to delete this attachment");
    }

    const result = await prisma.attachment.delete({
      where: { id }
    });

    if (attachment.projectId) {
      socketService.emitToProject(attachment.projectId, "attachment_deleted", { id, taskId: attachment.taskId });
    }

    return result;
  }

  static async getById(id: string) {
    return prisma.attachment.findUnique({
      where: { id }
    });
  }
}
