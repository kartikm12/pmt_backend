import { Prisma } from "@prisma/client";
import { addDays, startOfDay } from "date-fns";
import { prisma } from "../prisma/client.js";
import { ApiError } from "../utils/apiError.js";
import { ActivityService } from "../services/activity.service.js";
import { NotificationService } from "../services/notification.service.js";
import { socketService } from "../services/socket.service.js";
import { BoardService, type Stage } from "../services/board.service.js";
import { ProjectService } from "../services/project.service.js";
import { LIVE_PROJECT_STATUSES, MEMBERSHIP_ROLE, type UserRole } from "../constants/enums.js";
import { MAX_RULES_PER_PROJECT, type RuleInput } from "./rule.validator.js";

type Rule = Prisma.ProjectRuleGetPayload<object>;
type Action = { type: string; value: string };
type Conditions = { priorities?: string[]; label?: string; assigneeId?: string };
type Event =
  | { kind: "TASK_CREATED"; projectId: string; taskId: string }
  | { kind: "MOVED_TO_COLUMN"; projectId: string; taskId: string; columnId: string }
  | { kind: "ASSIGNED"; projectId: string; taskId: string; assignedIds: string[] };

const PRIORITY_WORD: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", URGENT: "Urgent" };

// Project rules: "when something happens to a task (only if ...), then do ...".
// A rule's own changes never set off other rules (they're applied here directly, not through TaskService),
// so two rules can't keep triggering each other.
export class RuleService {
  // ------------------------------------------------------------------ editing (project managers + Admins)
  static async list(projectId: string, userId: string, role: UserRole) {
    await ProjectService.requireProjectRole(projectId, userId, role, "viewer", { closedOk: true });
    return prisma.projectRule.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
  }

  static async create(projectId: string, input: RuleInput, userId: string, role: UserRole) {
    await ProjectService.requireProjectRole(projectId, userId, role, "manager");
    if ((await prisma.projectRule.count({ where: { projectId } })) >= MAX_RULES_PER_PROJECT) {
      throw new ApiError(400, `A project can have up to ${MAX_RULES_PER_PROJECT} rules. Remove one you no longer need first.`);
    }
    await this.assertRefsInProject(projectId, input);
    const rule = await prisma.projectRule.create({ data: { projectId, createdById: userId, ...this.data(input) } });
    await this.logChange(projectId, userId, "Added a rule");
    return rule;
  }

  static async update(projectId: string, ruleId: string, input: RuleInput, userId: string, role: UserRole) {
    await ProjectService.requireProjectRole(projectId, userId, role, "manager");
    await this.mustExist(projectId, ruleId);
    await this.assertRefsInProject(projectId, input);
    const rule = await prisma.projectRule.update({ where: { id: ruleId }, data: this.data(input) });
    await this.logChange(projectId, userId, "Changed a rule");
    return rule;
  }

  static async setEnabled(projectId: string, ruleId: string, enabled: boolean, userId: string, role: UserRole) {
    await ProjectService.requireProjectRole(projectId, userId, role, "manager");
    await this.mustExist(projectId, ruleId);
    const rule = await prisma.projectRule.update({ where: { id: ruleId }, data: { enabled } });
    await this.logChange(projectId, userId, enabled ? "Switched a rule on" : "Switched a rule off");
    return rule;
  }

  static async remove(projectId: string, ruleId: string, userId: string, role: UserRole) {
    await ProjectService.requireProjectRole(projectId, userId, role, "manager", { closedOk: true });
    await this.mustExist(projectId, ruleId);
    await prisma.projectRule.delete({ where: { id: ruleId } });
    await this.logChange(projectId, userId, "Removed a rule");
    return { success: true };
  }

  private static data(input: RuleInput) {
    return {
      enabled: input.enabled,
      trigger: input.trigger,
      triggerValue: input.trigger === "ASSIGNED" || input.trigger === "MOVED_TO_COLUMN" || input.trigger === "OVERDUE" ? input.triggerValue || null : null,
      conditions: input.conditions as Prisma.InputJsonValue,
      actions: input.actions as Prisma.InputJsonValue
    };
  }

  private static async mustExist(projectId: string, ruleId: string) {
    const r = await prisma.projectRule.findFirst({ where: { id: ruleId, projectId }, select: { id: true } });
    if (!r) throw new ApiError(404, "That rule doesn't exist any more");
  }

  private static async logChange(projectId: string, userId: string, description: string) {
    await ActivityService.log({ action: "PROJECT_UPDATED", entityType: "project", entityId: projectId, description, userId, projectId });
    socketService.emitToProject(projectId, "rules_updated", { projectId });
  }

  // Columns and people a rule names must belong to this project (people: active members of its team)
  private static async assertRefsInProject(projectId: string, input: RuleInput) {
    const columns = await BoardService.columnsOf(projectId);
    const columnIds = new Set(columns.map((c) => c.id));
    const wantColumns = [
      ...(input.trigger === "MOVED_TO_COLUMN" && input.triggerValue ? [input.triggerValue] : []),
      ...input.actions.filter((a) => a.type === "MOVE_TO_COLUMN").map((a) => a.value)
    ];
    if (wantColumns.some((c) => !columnIds.has(c))) throw new ApiError(400, "That column isn't on this project's board any more. Pick another.");

    const people = [
      ...(input.trigger === "ASSIGNED" && input.triggerValue ? [input.triggerValue] : []),
      ...(input.conditions.assigneeId ? [input.conditions.assigneeId] : []),
      ...input.actions.filter((a) => a.type === "ASSIGN" || a.type === "ADD_WATCHER" || (a.type === "NOTIFY" && a.value !== "PROJECT_MANAGERS" && a.value !== "ASSIGNEES")).map((a) => a.value)
    ];
    if (people.length) {
      const team = await prisma.projectMember.findMany({
        where: { projectId, removedAt: null, userId: { in: [...new Set(people)] }, user: { deletedAt: null, status: { not: "SUSPENDED" } } },
        select: { userId: true }
      });
      const ok = new Set(team.map((m) => m.userId));
      if (people.some((p) => !ok.has(p))) throw new ApiError(400, "Rules can only name people on this project's team.");
    }
  }

  // ------------------------------------------------------------------ running
  // Called after a person's change has been saved. Never throws: a broken rule must not undo their change.
  static async onEvent(evt: Event) {
    try {
      const rules = await prisma.projectRule.findMany({ where: { projectId: evt.projectId, enabled: true, trigger: evt.kind }, orderBy: { createdAt: "asc" } });
      if (!rules.length) return 0;
      let ran = 0;
      for (const rule of rules) {
        if (evt.kind === "MOVED_TO_COLUMN" && rule.triggerValue !== evt.columnId) continue;
        if (evt.kind === "ASSIGNED" && rule.triggerValue && !evt.assignedIds.includes(rule.triggerValue)) continue;
        if (await this.apply(rule, evt.taskId, `${evt.kind}:${Date.now()}`)) ran++;
      }
      return ran;
    } catch (err) {
      console.error("Rules failed for", evt, err);
      return 0;
    }
  }

  // The time-based rules, run with the reminder job: "due tomorrow" and "N days overdue". Each fires once
  // per task per due date (RuleRun's unique key), so a new due date can fire it again.
  static async runTimeRules(now = new Date()) {
    const rules = await prisma.projectRule.findMany({
      where: { enabled: true, trigger: { in: ["DUE_TOMORROW", "OVERDUE"] }, project: { deletedAt: null, status: { in: LIVE_PROJECT_STATUSES } } }
    });
    const today = startOfDay(now);
    let ran = 0;
    for (const rule of rules) {
      const due = rule.trigger === "DUE_TOMORROW"
        ? { gte: addDays(today, 1), lt: addDays(today, 2) }
        : { lt: addDays(today, -(Number(rule.triggerValue) - 1)) };
      const tasks = await prisma.task.findMany({
        where: { projectId: rule.projectId, deletedAt: null, status: { not: "DONE" }, dueDate: due },
        select: { id: true, dueDate: true },
        take: 500
      });
      for (const t of tasks) {
        try {
          if (await this.apply(rule, t.id, `${rule.trigger}:${t.dueDate!.toISOString()}`, { once: true })) ran++;
        } catch (err) {
          console.error("Time rule failed", rule.id, t.id, err);
        }
      }
    }
    return ran;
  }

  // Checks the rule's conditions on the task as it is now and, if they hold, does the actions.
  // once: claim the run first (time rules), so two servers or overlapping runs never double-fire.
  private static async apply(rule: Rule, taskId: string, key: string, opts: { once?: boolean } = {}) {
    const task = await prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: {
        id: true, title: true, status: true, columnId: true, priority: true, labels: true, projectId: true, startedAt: true, recurrence: true, nextOccurrenceId: true,
        assignees: { select: { id: true } },
        watchers: { select: { id: true } },
        project: { select: { managerId: true, status: true, deletedAt: true } }
      }
    });
    if (!task || task.projectId !== rule.projectId || task.project.deletedAt) return false;
    if (!LIVE_PROJECT_STATUSES.includes(task.project.status as never)) return false;

    const c = (rule.conditions ?? {}) as Conditions;
    if (c.priorities?.length && !c.priorities.includes(task.priority)) return false;
    if (c.label && !task.labels.some((l) => l.toLowerCase() === c.label!.toLowerCase())) return false;
    if (c.assigneeId && !task.assignees.some((a) => a.id === c.assigneeId)) return false;

    if (opts.once) {
      try {
        await prisma.ruleRun.create({ data: { ruleId: rule.id, taskId, key } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return false; // already fired
        throw e;
      }
    }

    // People named by the rule must still be active on the team when it runs (they may have left since)
    const team = await prisma.projectMember.findMany({
      where: { projectId: task.projectId, removedAt: null, user: { deletedAt: null, status: { not: "SUSPENDED" } } },
      select: { userId: true, role: true, user: { select: { fullName: true } } }
    });
    const onTeam = new Map(team.map((m) => [m.userId, m.user.fullName]));
    const columns = await BoardService.columnsOf(task.projectId);

    const data: Prisma.TaskUpdateInput = {};
    const did: string[] = [];
    const newlyAssigned: string[] = [];
    const newWatchers: string[] = [];
    const notify = new Set<string>();
    let labels = [...task.labels];
    let movedTo: { id: string; name: string; stage: Stage } | null = null;

    for (const a of (rule.actions ?? []) as Action[]) {
      if (a.type === "ASSIGN" && onTeam.has(a.value) && !task.assignees.some((x) => x.id === a.value) && !newlyAssigned.includes(a.value)) {
        newlyAssigned.push(a.value);
        did.push(`assigned ${onTeam.get(a.value)}`);
      } else if (a.type === "ADD_WATCHER" && onTeam.has(a.value) && !task.watchers.some((x) => x.id === a.value) && !newWatchers.includes(a.value)) {
        newWatchers.push(a.value);
        did.push(`added ${onTeam.get(a.value)} as a watcher`);
      } else if (a.type === "MOVE_TO_COLUMN") {
        const col = columns.find((x) => x.id === a.value);
        const here = BoardService.effectiveColumn(columns, task);
        if (col && col.id !== here.id) {
          movedTo = col;
          data.column = { connect: { id: col.id } };
          data.status = col.stage;
          if (col.stage !== task.status) {
            data.completedAt = col.stage === "DONE" ? new Date() : null;
            if (col.stage === "IN_PROGRESS" && !task.startedAt) data.startedAt = new Date();
          }
          did.push(`moved it to ${col.name}`);
        }
      } else if (a.type === "SET_PRIORITY" && a.value !== task.priority) {
        data.priority = a.value as never;
        did.push(`set priority to ${PRIORITY_WORD[a.value] ?? a.value}`);
      } else if (a.type === "ADD_LABEL" && !labels.some((l) => l.toLowerCase() === a.value.toLowerCase()) && labels.length < 10) {
        labels = [...labels, a.value];
        data.labels = labels;
        did.push(`added label ${a.value}`);
      } else if (a.type === "NOTIFY") {
        if (a.value === "ASSIGNEES") task.assignees.forEach((x) => notify.add(x.id));
        else if (a.value === "PROJECT_MANAGERS") {
          notify.add(task.project.managerId);
          team.filter((m) => m.role === MEMBERSHIP_ROLE.OWNER || m.role === MEMBERSHIP_ROLE.MANAGER).forEach((m) => notify.add(m.userId));
        } else if (onTeam.has(a.value)) notify.add(a.value);
      }
    }
    if (newlyAssigned.length) data.assignees = { connect: newlyAssigned.map((id) => ({ id })) };
    if (newWatchers.length) data.watchers = { connect: newWatchers.map((id) => ({ id })) };

    const changed = Object.keys(data).length > 0;
    if (!changed && notify.size === 0) return false; // nothing to do (e.g. already assigned): not counted as a run

    if (changed) await prisma.task.update({ where: { id: task.id }, data });
    const what = describeTrigger(rule, columns);
    const summary = did.length ? did.join(", ") : "sent a notice";
    await Promise.all([
      ActivityService.log({
        action: data.status && data.status !== task.status ? "TASK_STATUS_CHANGED" : "TASK_UPDATED",
        entityType: "task",
        entityId: task.id,
        description: `By rule (${what}): ${summary}`,
        projectId: task.projectId,
        taskId: task.id,
        metadata: { ruleId: rule.id }
      }),
      prisma.projectRule.update({ where: { id: rule.id }, data: { runCount: { increment: 1 }, lastRunAt: new Date() } }),
      opts.once ? Promise.resolve() : prisma.ruleRun.create({ data: { ruleId: rule.id, taskId, key } }).catch(() => undefined),
      ...newlyAssigned.map((id) => NotificationService.create({
        userId: id, type: "TASK_ASSIGNED", title: "New Task Assigned",
        message: `You have been assigned to task: ${task.title}`, projectId: task.projectId, taskId: task.id, email: true
      })),
      ...[...notify].map((id) => NotificationService.create({
        userId: id, type: "SYSTEM", title: "Rule notice",
        message: `'${task.title}': ${what}${did.length ? ` (${summary})` : ""}`, projectId: task.projectId, taskId: task.id, email: true
      }))
    ]);
    for (const id of newlyAssigned) socketService.emitToUser(id, "task_assigned", { taskId: task.id, title: task.title, projectId: task.projectId });
    if (changed) {
      socketService.emitToProject(task.projectId, "task_updated", { taskId: task.id, title: task.title, status: (data.status as string) ?? task.status, projectId: task.projectId, byRule: rule.id });
      socketService.emitToAll("task_activity_updated", { action: "UPDATED", taskId: task.id, projectId: task.projectId, status: (data.status as string) ?? task.status });
    }
    // A rule that finishes a repeating task still creates the next one (without running rules on it)
    if (movedTo?.stage === "DONE" && task.status !== "DONE" && task.recurrence && !task.nextOccurrenceId) {
      const { TaskService } = await import("../services/task.service.js");
      await TaskService.spawnNextOccurrence(task.id, rule.createdById ?? task.project.managerId, { fromRule: true });
    }
    return true;
  }
}

// The rule's "when" in words, for activity lines and notices
export function describeTrigger(rule: { trigger: string; triggerValue: string | null }, columns: { id: string; name: string }[]) {
  switch (rule.trigger) {
    case "TASK_CREATED": return "a task was created";
    case "MOVED_TO_COLUMN": return `moved to ${columns.find((c) => c.id === rule.triggerValue)?.name ?? "a column"}`;
    case "ASSIGNED": return "someone was assigned";
    case "DUE_TOMORROW": return "due tomorrow";
    case "OVERDUE": return `${rule.triggerValue} day${rule.triggerValue === "1" ? "" : "s"} overdue`;
    default: return rule.trigger;
  }
}
