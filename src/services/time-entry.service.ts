import { prisma } from "../prisma/client.js";
import type { UserRole } from "../constants/enums.js";
import { ApiError } from "../utils/apiError.js";
import { ProjectService } from "./project.service.js";
import { TaskService } from "./task.service.js";

// Hours spent on a task. Contributors log their own time; only project managers remove someone else's entry.
export class TimeEntryService {
  static async log(taskId: string, input: { minutes: number; note?: string; spentOn?: string }, userId: string, role: UserRole) {
    const task = await TaskService.getById(taskId, userId, role);
    await ProjectService.requireProjectRole(task.projectId, userId, role, "contributor");
    if (input.spentOn && new Date(input.spentOn) > new Date(Date.now() + 24 * 3600 * 1000)) {
      throw new ApiError(400, "Time can't be logged for a future date");
    }
    return prisma.timeEntry.create({
      data: { taskId, userId, minutes: input.minutes, note: input.note || null, spentOn: input.spentOn ? new Date(input.spentOn) : new Date() },
      include: { user: { select: { id: true, fullName: true, avatarUrl: true } } }
    });
  }

  static async remove(entryId: string, userId: string, role: UserRole) {
    const entry = await prisma.timeEntry.findUnique({ where: { id: entryId }, select: { userId: true, taskId: true } });
    if (!entry) throw new ApiError(404, "Time entry not found");
    const task = await TaskService.getById(entry.taskId, userId, role);
    const myRole = await ProjectService.requireProjectRole(task.projectId, userId, role, "contributor");
    if (entry.userId !== userId && myRole !== "manager") {
      throw new ApiError(403, "You can only remove your own time entries");
    }
    await prisma.timeEntry.delete({ where: { id: entryId } });
  }
}
