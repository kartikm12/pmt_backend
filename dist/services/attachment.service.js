import { prisma } from "../prisma/client.js";
import { socketService } from "./socket.service.js";
import { NotificationService } from "./notification.service.js";
import { ApiError } from "../utils/apiError.js";
import { ProjectService } from "./project.service.js";
import { TaskService } from "./task.service.js";
export class AttachmentService {
    static async assertAttachmentAccess(input) {
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
    static async list(filters) {
        await this.assertAttachmentAccess(filters);
        return prisma.attachment.findMany({
            where: filters.taskId
                ? { taskId: filters.taskId }
                : { projectId: filters.projectId || undefined },
            include: {
                user: {
                    select: { id: true, fullName: true, avatarUrl: true }
                }
            },
            orderBy: { createdAt: "desc" }
        });
    }
    static async create(data) {
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
            socketService.emitToProject(attachment.projectId, "attachment_added", attachment);
        }
        const { project, task, user } = attachment;
        // Determine who to notify
        let notifyUserIds = new Set();
        if (task && task.assignees) {
            task.assignees.forEach(a => notifyUserIds.add(a.id));
        }
        else if (project && project.members) {
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
    static async delete(id, userId, role) {
        const attachment = await this.getById(id);
        if (!attachment)
            throw new ApiError(404, "Attachment not found");
        await this.assertAttachmentAccess({
            projectId: attachment.projectId,
            taskId: attachment.taskId,
            userId,
            role
        });
        if (!ProjectService.isManagerRole(role) && attachment.userId !== userId) {
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
    static async getById(id) {
        return prisma.attachment.findUnique({
            where: { id }
        });
    }
}
