import { prisma } from "../prisma/client.js";
import { TASK_STATUS } from "../constants/enums.js";
import { ApiError } from "../utils/apiError.js";
import { ActivityService } from "./activity.service.js";
import { NotificationService } from "./notification.service.js";
import { socketService } from "./socket.service.js";
import { generateShortId } from "../utils/id.js";
import { ProjectService } from "./project.service.js";
export class TaskService {
    static async list(userId, role, projectId, page = 1, limit = 50) {
        const isManager = ProjectService.isManagerRole(role);
        const skip = (page - 1) * limit;
        const where = {
            deletedAt: null,
            projectId,
            ...(isManager ? {} : {
                OR: [
                    { assignees: { some: { id: userId } } },
                    { project: { members: { some: { userId, removedAt: null } } } }
                ]
            })
        };
        const [total, data] = await Promise.all([
            prisma.task.count({ where }),
            prisma.task.findMany({
                where,
                orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
                take: limit,
                skip,
                include: {
                    assignees: {
                        select: { id: true, fullName: true, email: true, avatarUrl: true }
                    },
                    project: {
                        select: { id: true, name: true, slug: true, status: true }
                    }
                }
            })
        ]);
        return {
            data,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) }
        };
    }
    static async getById(taskId, userId, role) {
        const isManager = !userId || !role || ProjectService.isManagerRole(role);
        const task = await prisma.task.findFirst({
            where: {
                id: taskId,
                deletedAt: null,
                ...(isManager ? {} : {
                    OR: [
                        { assignees: { some: { id: userId } } },
                        { project: { members: { some: { userId, removedAt: null } } } }
                    ]
                })
            },
            include: {
                assignees: {
                    select: { id: true, fullName: true, email: true, avatarUrl: true }
                },
                project: {
                    select: { id: true, name: true, slug: true, status: true }
                },
                comments: {
                    where: { deletedAt: null },
                    include: {
                        user: {
                            select: { id: true, fullName: true, avatarUrl: true }
                        }
                    },
                    orderBy: { createdAt: "desc" }
                }
            }
        });
        if (!task) {
            throw new ApiError(404, "Task not found");
        }
        return task;
    }
    static async create(actorUserId, input) {
        const task = await prisma.task.create({
            data: {
                id: generateShortId(),
                title: input.title,
                description: input.description,
                priority: input.priority,
                status: input.status,
                dueDate: input.dueDate ? new Date(input.dueDate) : null,
                projectId: input.projectId,
                assignees: input.assigneeIds ? {
                    connect: input.assigneeIds.map(id => ({ id }))
                } : undefined,
                createdById: actorUserId,
                sortOrder: input.sortOrder ?? 0,
                startedAt: input.status === TASK_STATUS.IN_PROGRESS ? new Date() : null,
                completedAt: input.status === TASK_STATUS.DONE ? new Date() : null
            }
        });
        await ActivityService.log({
            action: "TASK_CREATED",
            entityType: "task",
            entityId: task.id,
            description: `Created task ${task.title}`,
            userId: actorUserId,
            projectId: task.projectId,
            taskId: task.id
        });
        if (input.assigneeIds && input.assigneeIds.length > 0) {
            for (const assigneeId of input.assigneeIds) {
                await NotificationService.create({
                    userId: assigneeId,
                    type: "TASK_ASSIGNED",
                    title: "New Task Assigned",
                    message: `A new task '${task.title}' has been assigned to you`,
                    projectId: task.projectId,
                    taskId: task.id
                });
            }
        }
        // Emit Real-Time Event for Project Room
        socketService.emitToProject(task.projectId, "task_created", {
            taskId: task.id,
            title: task.title,
            projectId: task.projectId,
            status: task.status
        });
        // Global emission for leaderboard/activity feeds
        socketService.emitToAll("task_activity_updated", {
            action: "CREATED",
            taskId: task.id,
            projectId: task.projectId
        });
        if (input.assigneeIds && input.assigneeIds.length > 0) {
            for (const assigneeId of input.assigneeIds) {
                socketService.emitToUser(assigneeId, "task_assigned", {
                    taskId: task.id,
                    title: task.title,
                    projectId: task.projectId
                });
            }
        }
        return this.getById(task.id);
    }
    static async update(taskId, actorUserId, userRole, input) {
        const existingTask = await this.getById(taskId, actorUserId, userRole);
        const isManager = ProjectService.isManagerRole(userRole);
        if (!isManager) {
            // Non-managers can only update status (on any task)
            // Strip everything except status
            input = { status: input.status };
        }
        const completedAt = input.status === undefined
            ? undefined
            : input.status === TASK_STATUS.DONE
                ? new Date()
                : null;
        const updatedTask = await prisma.task.update({
            where: { id: taskId },
            data: {
                title: input.title,
                description: input.description,
                priority: input.priority,
                status: input.status,
                dueDate: input.dueDate === undefined ? undefined : input.dueDate ? new Date(input.dueDate) : null,
                projectId: input.projectId,
                assignees: input.assigneeIds === undefined ? undefined : {
                    set: input.assigneeIds.map(id => ({ id }))
                },
                sortOrder: input.sortOrder,
                startedAt: input.status === TASK_STATUS.IN_PROGRESS && !existingTask.startedAt ? new Date() : undefined,
                completedAt
            }
        });
        const description = input.status && input.status !== existingTask.status
            ? `Changed task status to ${input.status}`
            : `Updated task ${updatedTask.title}`;
        await ActivityService.log({
            action: input.status && input.status !== existingTask.status ? "TASK_STATUS_CHANGED" : "TASK_UPDATED",
            entityType: "task",
            entityId: taskId,
            description,
            userId: actorUserId,
            projectId: updatedTask.projectId,
            taskId,
            metadata: input
        });
        if (input.assigneeIds) {
            // Comparison logic is simpler here: just notify all if changed or specific diff if needed.
            // For now, notifying all new assignees for simplicity.
            for (const assigneeId of input.assigneeIds) {
                if (!existingTask.assignees.some(a => a.id === assigneeId)) {
                    await NotificationService.create({
                        userId: assigneeId,
                        type: "TASK_ASSIGNED",
                        title: "New Task Assigned",
                        message: `You have been assigned to task: ${updatedTask.title}`,
                        projectId: updatedTask.projectId,
                        taskId: taskId
                    });
                    socketService.emitToUser(assigneeId, "task_assigned", {
                        taskId: taskId,
                        title: updatedTask.title,
                        projectId: updatedTask.projectId,
                        assignedBy: actorUserId
                    });
                }
            }
        }
        // Emit Real-Time Event for Project Room
        if (input.projectId && input.projectId !== existingTask.projectId) {
            // Notify old project that task was moved (removed)
            socketService.emitToProject(existingTask.projectId, "task_deleted", {
                taskId: updatedTask.id,
                projectId: existingTask.projectId,
                movedTo: updatedTask.projectId
            });
            // Notify new project that task was added (created)
            socketService.emitToProject(updatedTask.projectId, "task_created", {
                taskId: updatedTask.id,
                title: updatedTask.title,
                projectId: updatedTask.projectId,
                status: updatedTask.status
            });
        }
        else {
            socketService.emitToProject(updatedTask.projectId, "task_updated", {
                taskId: updatedTask.id,
                title: updatedTask.title,
                status: updatedTask.status,
                projectId: updatedTask.projectId,
                updatedBy: actorUserId
            });
        }
        // Global emission for leaderboard/activity feeds
        socketService.emitToAll("task_activity_updated", {
            action: "UPDATED",
            taskId: taskId,
            projectId: updatedTask.projectId,
            status: updatedTask.status
        });
        // Emission for specific users moved into the loop above
        return this.getById(taskId);
    }
    static async remove(taskId, actorUserId) {
        const task = await this.getById(taskId);
        await prisma.task.update({
            where: { id: taskId },
            data: { deletedAt: new Date() }
        });
        await ActivityService.log({
            action: "TASK_DELETED",
            entityType: "task",
            entityId: taskId,
            description: `Deleted task ${task.title}`,
            userId: actorUserId,
            projectId: task.projectId,
            taskId
        });
        // Emit Real-Time Event
        socketService.emitToProject(task.projectId, "task_deleted", {
            taskId: task.id,
            projectId: task.projectId
        });
        // Global emission for leaderboard/activity feeds
        socketService.emitToAll("task_activity_updated", {
            action: "DELETED",
            taskId: task.id,
            projectId: task.projectId
        });
        return { success: true };
    }
}
