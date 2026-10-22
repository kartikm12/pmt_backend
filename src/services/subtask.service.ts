import { prisma } from "../prisma/client.js";
import type { UserRole } from "../constants/enums.js";
import { ApiError } from "../utils/apiError.js";
import { ProjectService } from "./project.service.js";
import { TaskService } from "./task.service.js";
import { socketService } from "./socket.service.js";

// Checklist items inside a task. Anyone who may move the task's status (contributor or above) may edit them.
export class SubtaskService {
  static async assertCanEdit(taskId: string, userId: string, role: UserRole) {
    const task = await TaskService.access(taskId, userId, role);
    ProjectService.checkRole(task.myRole, task.projectStatus, "contributor");
    return task;
  }

  static async create(taskId: string, title: string, userId: string, role: UserRole) {
    const task = await this.assertCanEdit(taskId, userId, role);
    const last = await prisma.subtask.findFirst({ where: { taskId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    const subtask = await prisma.subtask.create({ data: { taskId, title, sortOrder: (last?.sortOrder ?? -1) + 1 } });
    socketService.emitToProject(task.projectId, "task_updated", { taskId, projectId: task.projectId, status: task.status });
    return subtask;
  }

  static async update(subtaskId: string, input: { title?: string; done?: boolean }, userId: string, role: UserRole) {
    const existing = await prisma.subtask.findUnique({ where: { id: subtaskId }, select: { taskId: true } });
    if (!existing) throw new ApiError(404, "Checklist item not found");
    const task = await this.assertCanEdit(existing.taskId, userId, role);
    const subtask = await prisma.subtask.update({ where: { id: subtaskId }, data: { title: input.title, done: input.done } });
    socketService.emitToProject(task.projectId, "task_updated", { taskId: task.id, projectId: task.projectId, status: task.status });
    return subtask;
  }

  static async remove(subtaskId: string, userId: string, role: UserRole) {
    const existing = await prisma.subtask.findUnique({ where: { id: subtaskId }, select: { taskId: true } });
    if (!existing) throw new ApiError(404, "Checklist item not found");
    const task = await this.assertCanEdit(existing.taskId, userId, role);
    await prisma.subtask.delete({ where: { id: subtaskId } });
    socketService.emitToProject(task.projectId, "task_updated", { taskId: task.id, projectId: task.projectId, status: task.status });
  }
}
