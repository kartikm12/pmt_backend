import { Prisma } from "@prisma/client";
import { prisma } from "../prisma/client.js";
import { formatRule, nextOccurrence, normalizeRule, parseRule, upcoming, utcDate } from "../utils/repeatRule.js";
import { KEEP_DAYS, pastKeep } from "./trash-cleanup.service.js";
import { TASK_STATUS, type UserRole } from "../constants/enums.js";
import { ApiError } from "../utils/apiError.js";
import { ActivityService } from "./activity.service.js";
import { NotificationService } from "./notification.service.js";
import { socketService } from "./socket.service.js";
import { generateShortId } from "../utils/id.js";
import { ProjectService, type ProjectRole } from "./project.service.js";
import { LIVE_PROJECT_STATUSES, type ProjectStatus } from "../constants/enums.js";
import { withFileLink } from "../utils/fileLink.js";

type Status = "TODO" | "IN_PROGRESS" | "REVIEW" | "DONE";
type Priority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

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
  recurrence?: string | null;
  addAssigneeIds?: string[];
  blockedByIds?: string[];
};

// Activity text is shown as-is in the UI, so use the same words as the board columns
const STATUS_LABEL: Record<string, string> = { TODO: "To Do", IN_PROGRESS: "In Progress", REVIEW: "Review", DONE: "Completed" };

const userSummary = { select: { id: true, fullName: true, email: true, avatarUrl: true } };
// A task's people in one fixed order everywhere (list, task page, board): by name. Before, the order was
// whatever the database happened to return, so avatars could swap places between screens
const byName = [{ fullName: "asc" as const }, { id: "asc" as const }];

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

    // Speed: letting Prisma join people, project and checklist onto ~1000 tasks cost ~4x the plain read
    // (it builds an object per task-person pair). The same facts come as lean side-by-side queries in the
    // SAME database trip and are put together here. The extra queries read a little more than needed
    // (every live task's people and checklist counts); only the listed tasks' parts are used.
    const [total, rows, memberships, people, projects, checklist] = await Promise.all([
      prisma.task.count({ where }),
      prisma.task.findMany({
        where,
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
        take: limit,
        skip
      }),
      isManager ? Promise.resolve([]) : prisma.projectMember.findMany({ where: { userId, removedAt: null }, select: { projectId: true, role: true } }),
      prisma.$queryRaw<{ taskId: string; id: string; fullName: string; email: string; avatarUrl: string | null }[]>`
        SELECT ta."A" AS "taskId", u."id", u."fullName", u."email", u."avatarUrl"
        FROM "_TaskAssignees" ta
        JOIN "User" u ON u."id" = ta."B"
        JOIN "Task" t ON t."id" = ta."A"
        WHERE t."deletedAt" IS NULL ${projectId ? Prisma.sql`AND t."projectId" = ${projectId}` : Prisma.empty}
        ORDER BY ta."A", u."fullName", u."id" -- by name, like the task page and the board
      `,
      prisma.project.findMany({ where: projectId ? { id: projectId } : {}, select: { id: true, name: true, slug: true, status: true } }),
      prisma.subtask.groupBy({ by: ["taskId", "done"], where: { task: { deletedAt: null, ...(projectId ? { projectId } : {}) } }, _count: { _all: true } })
    ]);
    const peopleOf = new Map<string, { id: string; fullName: string; email: string; avatarUrl: string | null }[]>();
    for (const { taskId, ...person } of people) (peopleOf.get(taskId) ?? peopleOf.set(taskId, []).get(taskId)!).push(person);
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const steps = new Map<string, { total: number; done: number }>();
    for (const g of checklist) {
      const s = steps.get(g.taskId) ?? { total: 0, done: 0 };
      s.total += g._count._all;
      if (g.done) s.done += g._count._all;
      steps.set(g.taskId, s);
    }
    const data = rows.map((t) => ({ ...t, assignees: peopleOf.get(t.id) ?? [], project: projectById.get(t.projectId)! }));

    // Same rule as ProjectService.projectRole, computed once for the whole list
    const memberRole = new Map(memberships.map((m) => [m.projectId, m.role]));
    const roleFor = (pid: string): ProjectRole => {
      if (isManager) return "manager";
      const r = memberRole.get(pid);
      return r === "OWNER" || r === "MANAGER" ? "manager" : r === "VIEWER" ? "viewer" : "contributor";
    };

    return {
      data: data.map((t) => ({
        ...t,
        myRole: roleFor(t.projectId),
        subtaskTotal: steps.get(t.id)?.total ?? 0,
        subtaskDone: steps.get(t.id)?.done ?? 0
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
        _count: { select: { attachments: true } },
        assignees: { ...userSummary, orderBy: byName },
        watchers: { ...userSummary, orderBy: byName },
        createdBy: { select: { id: true, fullName: true } },
        project: {
          // deletedAt and this person's membership are read here so the role needs no second trip (removed below)
          select: { id: true, name: true, slug: true, status: true, deletedAt: true, members: userId ? { where: { userId, removedAt: null }, select: { role: true } } : false }
        },
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
            },
            attachments: { orderBy: { createdAt: "asc" } }
          },
          orderBy: { createdAt: "desc" }
        }
      }
    });

    if (!task) {
      throw new ApiError(404, "Task not found");
    }

    // Same rule as ProjectService.projectRole: anyone who got past the filter above is a member or an assignee
    const { deletedAt: projectDeletedAt, members, ...project } = task.project as typeof task.project & { members?: { role: string }[] };
    const myRole = userId && role && !projectDeletedAt
      ? ProjectService.roleFrom(role, members?.[0]?.role, task.assignees.some((a) => a.id === userId))
      : null;
    const comments = task.comments.map((c) => ({ ...c, attachments: c.attachments.map(withFileLink) }));
    return { ...task, project, comments, myRole };
  }

  // The light version of getById for changes that only need to know "may this person do it": the same
  // visibility rule and "Task not found", the person's role and the project's status, in one trip
  static async access(taskId: string, userId: string, role: UserRole) {
    const isManager = ProjectService.isManagerRole(role);
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
      select: {
        id: true, title: true, status: true, projectId: true,
        project: { select: { status: true, deletedAt: true, members: { where: { userId, removedAt: null }, select: { role: true } } } },
        assignees: { where: { id: userId }, select: { id: true } }
      }
    });
    if (!task) throw new ApiError(404, "Task not found");
    const myRole = task.project.deletedAt ? null : ProjectService.roleFrom(role, task.project.members[0]?.role, task.assignees.length > 0);
    return { id: task.id, title: task.title, status: task.status, projectId: task.projectId, projectStatus: task.project.status, myRole };
  }

  // Blockers must belong to the task's own project; a task can't block itself
  static async assertLinksInProject(projectId: string, input: { blockedByIds?: string[] }, selfId?: string) {
    if (input.blockedByIds?.length) {
      const ids = [...new Set(input.blockedByIds)];
      if (selfId && ids.includes(selfId)) throw new ApiError(400, "A task can't be blocked by itself");
      const found = await prisma.task.findMany({
        where: { id: { in: ids }, projectId, deletedAt: null },
        select: { id: true, blockedBy: { select: { id: true } } }
      });
      if (found.length !== ids.length) throw new ApiError(400, "Blocking tasks must be tasks in the same project");
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
    // The four checks don't depend on each other, so they run side by side; the first failing one, in this
    // order, is still the one reported (same answers as when they ran one after another)
    const checks = await Promise.allSettled([
      prisma.project.findFirst({ where: { id: input.projectId, deletedAt: null }, select: { id: true } })
        .then((project) => { if (!project) throw new ApiError(400, "Selected project does not exist"); }),
      ProjectService.requireProjectRole(input.projectId, actorUserId, actorRole, "manager"),
      ProjectService.assertActiveUsers(input.assigneeIds ?? []),
      this.assertLinksInProject(input.projectId, input)
    ]);
    const failed = checks.find((c): c is PromiseRejectedResult => c.status === "rejected");
    if (failed) throw failed.reason;
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
        recurrence: input.recurrence ? normalizeRule(input.recurrence, input.dueDate ? new Date(input.dueDate) : null) : null,
        blockedBy: input.blockedByIds?.length ? { connect: input.blockedByIds.map((id) => ({ id })) } : undefined,
        startedAt: input.status === TASK_STATUS.IN_PROGRESS ? new Date() : null,
        completedAt: input.status === TASK_STATUS.DONE ? new Date() : null
      }
    });

    // Log, notifications and reading the task back don't depend on each other: all at once
    const [, , fresh] = await Promise.all([
      ActivityService.log({
        action: "TASK_CREATED",
        entityType: "task",
        entityId: task.id,
        description: `Created task ${task.title}`,
        userId: actorUserId,
        projectId: task.projectId,
        taskId: task.id
      }),
      this.announceNewTask(task, input.assigneeIds ?? []),
      this.getById(task.id)
    ]);
    return fresh;
  }

  // A repeating task's next copy is announced in the bell only: a daily task would otherwise email every day
  static async announceNewTask(task: { id: string; title: string; projectId: string; status: string }, assigneeIds: string[], opts: { repeatDue?: Date } = {}) {
    // Each person's notice is independent of the others, so they're written side by side
    await Promise.all(assigneeIds.map(async (assigneeId) => {
      await NotificationService.create({
        userId: assigneeId,
        type: "TASK_ASSIGNED",
        title: opts.repeatDue ? "Repeating task ready" : "New Task Assigned",
        message: opts.repeatDue
          ? `The next '${task.title}' is ready, due ${opts.repeatDue.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}`
          : `A new task '${task.title}' has been assigned to you`,
        projectId: task.projectId,
        taskId: task.id,
        email: !opts.repeatDue
      });
      socketService.emitToUser(assigneeId, "task_assigned", { taskId: task.id, title: task.title, projectId: task.projectId });
    }));

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
    const myRole = ProjectService.checkRole(existingTask.myRole, existingTask.project.status, "contributor");
    const isManager = myRole === "manager";

    if (!isManager) {
      // Contributors may only move the status
      input = { status: input.status };
    }

    const targetProjectId = input.projectId ?? existingTask.projectId;
    const moved = isManager && !!input.projectId && input.projectId !== existingTask.projectId;
    if (moved) {
      await ProjectService.requireProjectRole(targetProjectId, actorUserId, userRole as UserRole, "manager");
      // Blockers don't travel to another project
      input.blockedByIds ??= [];
    }
    await this.assertLinksInProject(targetProjectId, input, taskId);
    // People already on the task stay assignable even if suspended since; only new picks are checked
    if (input.assigneeIds) await ProjectService.assertActiveUsers(input.assigneeIds, existingTask.assignees.map((a) => a.id));
    if (input.addAssigneeIds?.length) {
      await ProjectService.assertActiveUsers(input.addAssigneeIds, existingTask.assignees.map((a) => a.id));
      if (!input.assigneeIds) input.assigneeIds = [...new Set([...existingTask.assignees.map((a) => a.id), ...input.addAssigneeIds])];
    }

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
        recurrence: input.recurrence === undefined ? undefined : input.recurrence ? normalizeRule(input.recurrence, newDue ?? existingTask.dueDate) : null,
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

    if (moved) {
      // Moving takes the task out of its old project's dependencies both ways, and its files go with it
      sideEffects.push(prisma.task.update({ where: { id: taskId }, data: { blocks: { set: [] } } }));
      sideEffects.push(prisma.attachment.updateMany({ where: { taskId }, data: { projectId: targetProjectId } }));
      sideEffects.push((async () => {
        const watchers = await prisma.user.findMany({ where: { watchedTasks: { some: { id: taskId } } }, select: { id: true, role: true } });
        const lost = [];
        for (const w of watchers) if (!(await ProjectService.projectRole(targetProjectId, w.id, w.role as UserRole))) lost.push({ id: w.id });
        if (lost.length) await prisma.task.update({ where: { id: taskId }, data: { watchers: { disconnect: lost } } });
      })());
    }
    if (statusChanged && updatedTask.status === TASK_STATUS.DONE && updatedTask.recurrence && !updatedTask.nextOccurrenceId) {
      sideEffects.push(this.spawnNextOccurrence(taskId, actorUserId));
    }

    // The fresh copy for the reply doesn't need the side effects, so it loads alongside them
    const [fresh] = await Promise.all([this.getById(taskId, actorUserId, userRole as UserRole), ...sideEffects]);
    return fresh;
  }

  // Repeating task finished: create the next one, once (nextOccurrenceId guards re-completing and two
  // "done" clicks at the same moment). The next deadline follows the rule from the current deadline but is
  // never in the past, so a late finish doesn't create an overdue copy. COUNT/UNTIL end the series.
  static async spawnNextOccurrence(taskId: string, actorUserId: string) {
    const t = await prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      include: {
        assignees: { where: { deletedAt: null, status: { not: "SUSPENDED" } }, select: { id: true } },
        watchers: { where: { deletedAt: null, status: { not: "SUSPENDED" } }, select: { id: true } },
        subtasks: true
      }
    });
    const project = await prisma.project.findUnique({ where: { id: t.projectId }, select: { status: true, deletedAt: true } });
    if (!project || project.deletedAt || !LIVE_PROJECT_STATUSES.includes(project.status as ProjectStatus)) return null;
    const ruleText = t.recurrence ? normalizeRule(t.recurrence, t.dueDate) : null;
    const rule = ruleText ? parseRule(ruleText) : null;
    if (!rule || rule.count === 1) return null;
    const anchor = t.dueDate ?? new Date();
    const nextDue = nextOccurrence(rule, anchor, new Date());
    if (!nextDue) return null;

    const nextId = generateShortId();
    const claim = await prisma.task.updateMany({ where: { id: taskId, nextOccurrenceId: null }, data: { nextOccurrenceId: nextId } });
    if (claim.count === 0) return null;
    // A start date keeps the same lead time before the deadline
    const nextStart = t.startDate && t.dueDate ? new Date(nextDue.getTime() - (utcDate(t.dueDate).getTime() - utcDate(t.startDate).getTime())) : null;
    const next = await prisma.task.create({
      data: {
        id: nextId,
        title: t.title,
        description: t.description,
        priority: t.priority,
        status: "TODO",
        dueDate: nextDue,
        startDate: nextStart,
        projectId: t.projectId,
        createdById: actorUserId,
        sortOrder: t.sortOrder,
        labels: t.labels,
        estimateHours: t.estimateHours,
        recurrence: formatRule({ ...rule, count: rule.count ? rule.count - 1 : undefined }),
        assignees: { connect: t.assignees },
        watchers: { connect: t.watchers },
        subtasks: { create: t.subtasks.map((s) => ({ title: s.title, sortOrder: s.sortOrder })) }
      }
    });
    await ActivityService.log({
      action: "TASK_CREATED",
      entityType: "task",
      entityId: next.id,
      description: `Created the next one of repeating task ${t.title}`,
      userId: actorUserId,
      projectId: t.projectId,
      taskId: next.id
    });
    await this.announceNewTask(next, t.assignees.map((a) => a.id), { repeatDue: nextDue });
    return next;
  }

  static repeatPreview(ruleText: string, due: string | undefined) {
    const anchor = due && !isNaN(Date.parse(due)) ? new Date(due) : new Date();
    const normalized = normalizeRule(ruleText, anchor);
    const rule = normalized ? parseRule(normalized) : null;
    if (!rule) throw new ApiError(400, "That repeat setting isn't valid");
    return { rule: normalized, next: upcoming(rule, anchor, 3).map((d) => d.toISOString().slice(0, 10)) };
  }

  static async remove(taskId: string, actorUserId: string, actorRole: UserRole) {
    const task = await this.getById(taskId, actorUserId, actorRole);
    ProjectService.checkRole(task.myRole, task.project.status, "manager");

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
    await this.access(taskId, userId, role); // anyone who can see the task may follow it
    await prisma.task.update({
      where: { id: taskId },
      data: { watchers: watch ? { connect: { id: userId } } : { disconnect: { id: userId } } }
    });
    return { watching: watch };
  }
}
