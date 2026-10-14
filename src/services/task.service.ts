import { prisma } from "../prisma/client.js";
import { KEEP_DAYS, pastKeep } from "./trash-cleanup.service.js";
import { TASK_STATUS, type UserRole } from "../constants/enums.js";
import { ApiError } from "../utils/apiError.js";
import { ActivityService } from "./activity.service.js";
import { NotificationService } from "./notification.service.js";
import { socketService } from "./socket.service.js";
import { generateShortId } from "../utils/id.js";
import { ProjectService, type ProjectRole } from "./project.service.js";

type Status = "TODO" | "IN_PROGRESS" | "REVIEW" | "DONE";
type Priority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
type Recurrence = "DAILY" | "WEEKLY" | "MONTHLY";

type TaskFields = {
  title?: string;
  description?: string;
  priority?: Priority;
  status?: Status;
  dueDate?: string | null;
  startDate?: string | null;
  projectId?: string;
  assigneeIds?: string[];
  sortOrder?: number;
  labels?: string[];
  estimateHours?: number | null;
  recurrence?: Recurrence | null;
  milestoneId?: string | null;
  blockedByIds?: string[];
};

// Activity text is shown as-is in the UI, so use the same words as the board columns
const STATUS_LABEL: Record<string, string> = { TODO: "To Do", IN_PROGRESS: "In Progress", REVIEW: "Review", DONE: "Completed" };

const userSummary = { select: { id: true, fullName: true, email: true, avatarUrl: true } };

export class TaskService {
  // shortcut: the UI has no paging and reads one page, so the page is large; add paging to the UI past ~1000 tasks
  static async list(userId: string, role: UserRole, projectId?: string, page = 1, limit = 1000) {
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

    const [total, data, memberships] = await Promise.all([
      prisma.task.count({ where }),
      prisma.task.findMany({
        where,
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
        take: limit,
        skip,
        include: {
          assignees: userSummary,
          project: {
            select: { id: true, name: true, slug: true, status: true }
          },
          subtasks: { select: { done: true } }
        }
      }),
      isManager ? Promise.resolve([]) : prisma.projectMember.findMany({ where: { userId, removedAt: null }, select: { projectId: true, role: true } })
    ]);

    // Same rule as ProjectService.projectRole, computed once for the whole list
    const memberRole = new Map(memberships.map((m) => [m.projectId, m.role]));
    const roleFor = (pid: string): ProjectRole => {
      if (isManager) return "manager";
      const r = memberRole.get(pid);
      return r === "OWNER" || r === "MANAGER" ? "manager" : r === "VIEWER" ? "viewer" : "contributor";
    };

    return {
      data: data.map(({ subtasks, ...t }) => ({
        ...t,
        myRole: roleFor(t.projectId),
        subtaskTotal: subtasks.length,
        subtaskDone: subtasks.filter((s) => s.done).length
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) }
    };
  }

  static async getById(taskId: string, userId?: string, role?: UserRole) {
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
        assignees: userSummary,
        watchers: userSummary,
        createdBy: { select: { id: true, fullName: true } },
        project: {
          select: { id: true, name: true, slug: true, status: true }
        },
        milestone: { select: { id: true, name: true, dueDate: true } },
        subtasks: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        blockedBy: { where: { deletedAt: null }, select: { id: true, title: true, status: true } },
        blocks: { where: { deletedAt: null }, select: { id: true, title: true, status: true } },
        timeEntries: {
          orderBy: { spentOn: "desc" },
          include: { user: { select: { id: true, fullName: true, avatarUrl: true } } }
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

    const myRole = userId && role ? await ProjectService.projectRole(task.projectId, userId, role) : null;
    return { ...task, myRole };
  }

  // Milestones and blockers must belong to the task's own project; a task can't block itself
  static async assertLinksInProject(projectId: string, input: { milestoneId?: string | null; blockedByIds?: string[] }, selfId?: string) {
    if (input.milestoneId) {
      const ok = await prisma.milestone.count({ where: { id: input.milestoneId, projectId } });
      if (!ok) throw new ApiError(400, "That milestone belongs to another project");
    }
    if (input.blockedByIds?.length) {
      const ids = [...new Set(input.blockedByIds)];
      if (selfId && ids.includes(selfId)) throw new ApiError(400, "A task can't be blocked by itself");
      const found = await prisma.task.findMany({
        where: { id: { in: ids }, projectId, deletedAt: null },
        select: { id: true, blockedBy: { select: { id: true } } }
      });
      if (found.length !== ids.length) throw new ApiError(400, "Blocking tasks must be open tasks in the same project");
      // shortcut: only direct two-way loops are refused; longer chains are allowed and just show warnings
      if (selfId && found.some((t) => t.blockedBy.some((b) => b.id === selfId))) {
        throw new ApiError(400, "Those two tasks would block each other");
      }
    }
  }

  static assertDateOrder(start: Date | null | undefined, due: Date | null | undefined) {
    if (start && due && start.getTime() > due.getTime()) throw new ApiError(400, "Start date must be on or before the deadline.");
  }

  static async create(actorUserId: string, actorRole: UserRole, input: TaskFields & { title: string; projectId: string }) {
    // A task in a missing or archived project would be invisible everywhere
    const project = await prisma.project.findFirst({ where: { id: input.projectId, deletedAt: null }, select: { id: true } });
    if (!project) throw new ApiError(400, "Selected project does not exist");
    await ProjectService.requireProjectRole(input.projectId, actorUserId, actorRole, "manager");
    await ProjectService.assertActiveUsers(input.assigneeIds ?? []);
    await this.assertLinksInProject(input.projectId, input);
    this.assertDateOrder(input.startDate ? new Date(input.startDate) : null, input.dueDate ? new Date(input.dueDate) : null);

    const task = await prisma.task.create({
      data: {
        id: generateShortId(),
        title: input.title,
        description: input.description,
        priority: input.priority,
        status: input.status,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        startDate: input.startDate ? new Date(input.startDate) : null,
        projectId: input.projectId,
        assignees: input.assigneeIds ? {
          connect: input.assigneeIds.map(id => ({ id }))
        } : undefined,
        createdById: actorUserId,
        sortOrder: input.sortOrder ?? 0,
        labels: input.labels ?? [],
        estimateHours: input.estimateHours ?? null,
        recurrence: input.recurrence ?? null,
        milestoneId: input.milestoneId ?? null,
        blockedBy: input.blockedByIds?.length ? { connect: input.blockedByIds.map((id) => ({ id })) } : undefined,
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

    await this.announceNewTask(task, input.assigneeIds ?? []);
    return this.getById(task.id);
  }

  static async announceNewTask(task: { id: string; title: string; projectId: string; status: string }, assigneeIds: string[]) {
    for (const assigneeId of assigneeIds) {
      await NotificationService.create({
        userId: assigneeId,
        type: "TASK_ASSIGNED",
        title: "New Task Assigned",
        message: `A new task '${task.title}' has been assigned to you`,
        projectId: task.projectId,
        taskId: task.id,
        email: true
      });
      socketService.emitToUser(assigneeId, "task_assigned", { taskId: task.id, title: task.title, projectId: task.projectId });
    }

    // Emit Real-Time Event for Project Room
    socketService.emitToProject(task.projectId, "task_created", {
      taskId: task.id,
      title: task.title,
      projectId: task.projectId,
      status: task.status
    });

    // Global emission for leaderboard/activity feeds
    socketService.emitToAll("task_activity_updated", { action: "CREATED", taskId: task.id, projectId: task.projectId });
  }

  static async update(taskId: string, actorUserId: string, userRole: string, input: TaskFields) {
    const existingTask = await this.getById(taskId, actorUserId, userRole as UserRole);
    const myRole = await ProjectService.requireProjectRole(existingTask.projectId, actorUserId, userRole as UserRole, "contributor");
    const isManager = myRole === "manager";

    if (!isManager) {
      // Contributors may only move the status
      input = { status: input.status };
    }

    const targetProjectId = input.projectId ?? existingTask.projectId;
    if (isManager && input.projectId && input.projectId !== existingTask.projectId) {
      await ProjectService.requireProjectRole(input.projectId, actorUserId, userRole as UserRole, "manager");
      // Milestones and blockers don't travel to another project
      input.milestoneId ??= null;
      input.blockedByIds ??= [];
    }
    await this.assertLinksInProject(targetProjectId, input, taskId);
    // People already on the task stay assignable even if suspended since; only new picks are checked
    if (input.assigneeIds) await ProjectService.assertActiveUsers(input.assigneeIds, existingTask.assignees.map((a) => a.id));

    // Only stamp completion when the status actually changes; the edit form always resends the status,
    // which used to reset completedAt on every save and skew the leaderboard and reports
    const statusChanged = input.status !== undefined && input.status !== existingTask.status;
    const completedAt = !statusChanged ? undefined : input.status === TASK_STATUS.DONE ? new Date() : null;

    // A new due date earns fresh "due soon" / "overdue" reminders
    const newDue = input.dueDate === undefined ? undefined : input.dueDate ? new Date(input.dueDate) : null;
    const dueChanged = newDue !== undefined && (newDue?.getTime() ?? null) !== (existingTask.dueDate?.getTime() ?? null);
    // Checked only when a date is being changed, so old tasks with odd dates can still be moved along
    if (input.startDate !== undefined || input.dueDate !== undefined) {
      const newStart = input.startDate === undefined ? existingTask.startDate : input.startDate ? new Date(input.startDate) : null;
      this.assertDateOrder(newStart, newDue === undefined ? existingTask.dueDate : newDue);
    }

    const updatedTask = await prisma.task.update({
      where: { id: taskId },
      data: {
        title: input.title,
        description: input.description,
        priority: input.priority,
        status: input.status,
        dueDate: newDue,
        ...(dueChanged ? { dueSoonNotifiedAt: null, overdueNotifiedAt: null } : {}),
        startDate: input.startDate === undefined ? undefined : input.startDate ? new Date(input.startDate) : null,
        projectId: input.projectId,
        assignees: input.assigneeIds === undefined ? undefined : {
          set: input.assigneeIds.map(id => ({ id }))
        },
        sortOrder: input.sortOrder,
        labels: input.labels,
        estimateHours: input.estimateHours,
        recurrence: input.recurrence,
        milestoneId: input.milestoneId,
        blockedBy: input.blockedByIds === undefined ? undefined : { set: input.blockedByIds.map((id) => ({ id })) },
        startedAt:
          input.status === TASK_STATUS.IN_PROGRESS && !existingTask.startedAt ? new Date() : undefined,
        completedAt
      }
    });

    const description = statusChanged
      ? `Changed task status to ${STATUS_LABEL[input.status!] ?? input.status}`
      : `Updated task ${updatedTask.title}`;

    // After the save, the log entry and notifications don't depend on each other: they go out together
    // (each sequential database trip costs ~160 ms on the live hosting)
    const sideEffects: Promise<unknown>[] = [];
    sideEffects.push(ActivityService.log({
      action: statusChanged ? "TASK_STATUS_CHANGED" : "TASK_UPDATED",
      entityType: "task",
      entityId: taskId,
      description,
      userId: actorUserId,
      projectId: updatedTask.projectId,
      taskId,
      metadata: input
    }));

    if (input.assigneeIds) {
      for (const assigneeId of input.assigneeIds) {
        if (!existingTask.assignees.some(a => a.id === assigneeId)) {
          sideEffects.push(NotificationService.create({
            userId: assigneeId,
            type: "TASK_ASSIGNED",
            title: "New Task Assigned",
            message: `You have been assigned to task: ${updatedTask.title}`,
            projectId: updatedTask.projectId,
            taskId: taskId,
            email: true
          }));

          socketService.emitToUser(assigneeId, "task_assigned", {
            taskId: taskId,
            title: updatedTask.title,
            projectId: updatedTask.projectId,
            assignedBy: actorUserId
          });
        }
      }
    }

    // Watchers hear about status changes (assignees already follow the task on their own)
    const watchers = existingTask.watchers.filter((w) => w.id !== actorUserId);
    if (statusChanged && watchers.length) {
      sideEffects.push((async () => {
        const actor = await prisma.user.findUnique({ where: { id: actorUserId }, select: { fullName: true } });
        await Promise.all(watchers.map((w) => NotificationService.create({
          userId: w.id,
          type: "SYSTEM",
          title: "Task updated",
          message: `${actor?.fullName ?? "Someone"} moved '${updatedTask.title}' to ${STATUS_LABEL[updatedTask.status]}`,
          projectId: updatedTask.projectId,
          taskId
        })));
      })());
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
    } else {
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

    if (statusChanged && updatedTask.status === TASK_STATUS.DONE && updatedTask.recurrence && !updatedTask.nextOccurrenceId) {
      sideEffects.push(this.spawnNextOccurrence(taskId, actorUserId));
    }

    // The fresh copy for the reply doesn't need the side effects, so it loads alongside them
    const [fresh] = await Promise.all([this.getById(taskId, actorUserId, userRole as UserRole), ...sideEffects]);
    return fresh;
  }

  // Recurring task finished: create the next one (once; nextOccurrenceId guards re-completing)
  static async spawnNextOccurrence(taskId: string, actorUserId: string) {
    // Claim first: two "done" requests at the same moment must not both create the next copy
    const nextId = generateShortId();
    const claim = await prisma.task.updateMany({ where: { id: taskId, nextOccurrenceId: null }, data: { nextOccurrenceId: nextId } });
    if (claim.count === 0) return;
    const t = await prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      include: { assignees: { where: { deletedAt: null, status: { not: "SUSPENDED" } }, select: { id: true } }, subtasks: true }
    });
    const step = (d: Date | null) => {
      if (!d) return null;
      const next = new Date(d);
      if (t.recurrence === "DAILY") next.setDate(next.getDate() + 1);
      else if (t.recurrence === "WEEKLY") next.setDate(next.getDate() + 7);
      else {
        // Monthly: the 31st becomes the last day of a shorter month (setMonth alone rolls Jan 31 to Mar 3)
        const day = next.getDate();
        next.setDate(1);
        next.setMonth(next.getMonth() + 1);
        const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
        next.setDate(Math.min(day, lastDay));
      }
      return next;
    };
    const next = await prisma.task.create({
      data: {
        id: nextId,
        title: t.title,
        description: t.description,
        priority: t.priority,
        status: "TODO",
        dueDate: step(t.dueDate ?? new Date()),
        startDate: step(t.startDate),
        projectId: t.projectId,
        createdById: actorUserId,
        sortOrder: t.sortOrder,
        labels: t.labels,
        estimateHours: t.estimateHours,
        recurrence: t.recurrence,
        milestoneId: t.milestoneId,
        assignees: { connect: t.assignees },
        subtasks: { create: t.subtasks.map((s) => ({ title: s.title, sortOrder: s.sortOrder })) }
      }
    });
    await ActivityService.log({
      action: "TASK_CREATED",
      entityType: "task",
      entityId: next.id,
      description: `Created the next ${t.recurrence!.toLowerCase()} occurrence of ${t.title}`,
      userId: actorUserId,
      projectId: t.projectId,
      taskId: next.id
    });
    await this.announceNewTask(next, t.assignees.map((a) => a.id));
    return next;
  }

  static async remove(taskId: string, actorUserId: string, actorRole: UserRole) {
    const task = await this.getById(taskId, actorUserId, actorRole);
    await ProjectService.requireProjectRole(task.projectId, actorUserId, actorRole, "manager");

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

  // Recently deleted: bring a task back (its project must still exist)
  static async restore(taskId: string, actorUserId: string) {
    const task = await prisma.task.findFirst({ where: { id: taskId, deletedAt: { not: null } }, include: { project: { select: { deletedAt: true } } } });
    if (!task || !task.deletedAt) throw new ApiError(404, "Deleted task not found");
    if (pastKeep(task.deletedAt)) throw new ApiError(410, `This task was deleted more than ${KEEP_DAYS} days ago and can't be restored.`);
    if (task.project.deletedAt) throw new ApiError(400, "Restore its project first");
    await prisma.task.update({ where: { id: taskId }, data: { deletedAt: null } });
    await ActivityService.log({
      action: "TASK_UPDATED",
      entityType: "task",
      entityId: taskId,
      description: `Restored task ${task.title}`,
      userId: actorUserId,
      projectId: task.projectId,
      taskId
    });
    socketService.emitToProject(task.projectId, "task_created", { taskId, title: task.title, projectId: task.projectId, status: task.status });
    return { success: true };
  }

  // Saved card order inside one board column; anyone who can move cards may reorder them
  static async reorder(input: { projectId: string; status: Status; orderedIds: string[] }, actorUserId: string, actorRole: UserRole) {
    await ProjectService.requireProjectRole(input.projectId, actorUserId, actorRole, "contributor");
    const tasks = await prisma.task.findMany({
      where: { id: { in: input.orderedIds }, projectId: input.projectId, status: input.status, deletedAt: null },
      select: { id: true }
    });
    if (tasks.length !== new Set(input.orderedIds).size) {
      throw new ApiError(400, "Those cards aren't all in that column any more; refresh and try again");
    }
    await prisma.$transaction(input.orderedIds.map((id, index) => prisma.task.update({ where: { id }, data: { sortOrder: index } })));
    socketService.emitToProject(input.projectId, "tasks_reordered", { projectId: input.projectId, status: input.status, orderedIds: input.orderedIds });
    return { success: true };
  }

  static async setWatching(taskId: string, watch: boolean, userId: string, role: UserRole) {
    await this.getById(taskId, userId, role); // anyone who can see the task may follow it
    await prisma.task.update({
      where: { id: taskId },
      data: { watchers: watch ? { connect: { id: userId } } : { disconnect: { id: userId } } }
    });
    return { watching: watch };
  }
}
