import { prisma } from "../prisma/client.js";
import { PROJECT_STATUS, TASK_STATUS } from "../constants/enums.js";
import { addDays, differenceInCalendarDays, endOfDay, startOfDay, startOfToday, subDays, format } from "date-fns";
import { NOT_IN_PAUSED_PROJECT } from "../constants/enums.js";

const MANAGER_ROLES = ["ADMIN", "MANAGER", "PROJECT_MANAGER"];

export class ReportsService {
  static async getComprehensiveReport(userId: string, role: string, filters: { days?: number, projectId?: string, memberId?: string } = {}) {
    // Bound the range: an unchecked ?days= builds one bucket per day
    const daysCount = Math.min(Math.max(Math.trunc(filters.days || 7), 1), 365);
    const isManager = MANAGER_ROLES.includes(role);

    const taskBaseWhere: any = { deletedAt: null, project: { deletedAt: null } };
    const projectBaseWhere: any = { deletedAt: null };
    const activityBaseWhere: any = {};

    if (!isManager) {
      taskBaseWhere.assignees = { some: { id: userId } };
      projectBaseWhere.members = { some: { userId, removedAt: null } };
      // Normal users only see their own activities or activities on tasks/projects they are part of.
      activityBaseWhere.OR = [
        { userId: userId },
        { task: { assignees: { some: { id: userId } } } },
        { project: { members: { some: { userId, removedAt: null } } } }
      ];
    }

    if (filters.projectId) {
      taskBaseWhere.projectId = filters.projectId;
      projectBaseWhere.id = filters.projectId;
      activityBaseWhere.projectId = filters.projectId;
    }
    // Only managers may look at another person's numbers; for anyone else it would replace their own scope
    if (filters.memberId && isManager) {
      taskBaseWhere.assignees = { some: { id: filters.memberId } };
      projectBaseWhere.members = { some: { userId: filters.memberId } };
      activityBaseWhere.userId = filters.memberId;
    }

    // 1. Completion Trends
    const days = Array.from({ length: daysCount }).map((_, i) => {
      const date = subDays(new Date(), (daysCount - 1) - i);
      return {
        start: startOfDay(date),
        // Whole calendar days: "now + 24 h" overlapped the next day and counted tasks twice
        end: endOfDay(date),
        label: daysCount > 7 ? format(date, "MMM d") : format(date, "EEE")
      };
    });

    const startRange = days[0].start;
    const endRange = days[days.length - 1].end;
    // The same length of time just before, for "vs previous period"
    const prevStart = subDays(startRange, daysCount);
    const today = startOfToday();

    // All independent reads go out together (Prisma queries start when awaited): each sequential
    // database trip costs ~160 ms on the live hosting
    const [
      tasksInRange,
      statusCounts,
      activeProjects,
      overdueTasksDb,
      allRelevantTasks,
      recentActivity,
      activeProjectCount,
      totalCompletedTasks,
      totalPendingTasks,
      totalOverdueTasks,
      overdueByProject
    ] = await Promise.all([
      prisma.task.findMany({
        where: {
          ...taskBaseWhere,
          OR: [
            { createdAt: { gte: prevStart, lte: endRange } },
            { completedAt: { gte: prevStart, lte: endRange } }
          ]
        },
        select: { status: true, createdAt: true, completedAt: true, dueDate: true }
      }),
      prisma.task.groupBy({
        by: ["status"],
        where: taskBaseWhere,
        _count: true
      }),
      prisma.project.findMany({
        where: { ...projectBaseWhere, status: PROJECT_STATUS.ACTIVE },
        include: {
          tasks: { where: taskBaseWhere, include: { timeEntries: { select: { minutes: true } } } }
        }
      }),
      prisma.task.findMany({
        where: {
          ...taskBaseWhere,
          status: { not: TASK_STATUS.DONE },
          dueDate: { lt: startOfToday() }
        },
        include: {
          assignees: { select: { fullName: true, avatarUrl: true } },
          project: { select: { id: true, name: true } }
        },
        orderBy: { dueDate: 'asc' },
        take: 10
      }),
      prisma.task.findMany({
        where: taskBaseWhere,
        include: {
          assignees: { select: { id: true, fullName: true, avatarUrl: true } }
        }
      }),
      prisma.activityLog.findMany({
        where: activityBaseWhere,
        include: {
          user: { select: { fullName: true, avatarUrl: true } }
        },
        orderBy: { createdAt: 'desc' },
        take: 10
      }),
      prisma.project.count({ where: { ...projectBaseWhere, status: PROJECT_STATUS.ACTIVE } }),
      prisma.task.count({ where: { ...taskBaseWhere, status: TASK_STATUS.DONE } }),
      prisma.task.count({ where: { ...taskBaseWhere, status: { not: TASK_STATUS.DONE } } }),
      prisma.task.count({
        where: { ...taskBaseWhere, ...NOT_IN_PAUSED_PROJECT, status: { not: TASK_STATUS.DONE }, dueDate: { lt: startOfToday() } }
      }),
      prisma.task.groupBy({
        by: ["projectId"],
        where: { ...taskBaseWhere, ...NOT_IN_PAUSED_PROJECT, status: { not: TASK_STATUS.DONE }, dueDate: { lt: startOfToday() } },
        _count: true
      })
    ]);


    const trends = days.map((day) => {
      let created = 0;
      let completed = 0;
      for (const t of tasksInRange) {
        if (t.createdAt >= day.start && t.createdAt <= day.end) created++;
        if (t.status === TASK_STATUS.DONE && t.completedAt && t.completedAt >= day.start && t.completedAt <= day.end) completed++;
      }
      return {
        name: day.label,
        completed,
        new: created
      };
    });

    // Headline numbers: this period against the same length of time just before
    const inWindow = (d: Date | null, from: Date, to: Date) => !!d && d >= from && d <= to;
    // Deadlines are whole days: finishing any time on the due day counts as on time
    const onTime = (t: { completedAt: Date | null; dueDate: Date | null }) => !!t.completedAt && !!t.dueDate && t.completedAt < addDays(startOfDay(t.dueDate), 1);
    const periodNumbers = (from: Date, to: Date) => {
      const done = tasksInRange.filter((t) => t.status === TASK_STATUS.DONE && inWindow(t.completedAt, from, to));
      const withDeadline = done.filter((t) => t.dueDate);
      return {
        completed: done.length,
        created: tasksInRange.filter((t) => inWindow(t.createdAt, from, to)).length,
        onTimeRate: withDeadline.length ? Math.round((withDeadline.filter(onTime).length / withDeadline.length) * 100) : null
      };
    };
    const summary = {
      days: daysCount,
      current: periodNumbers(startRange, endRange),
      previous: periodNumbers(prevStart, new Date(startRange.getTime() - 1)),
      overdueNow: totalOverdueTasks,
      overdueProjects: overdueByProject.length
    };

    // 2. Tasks by Status

    const statusData = statusCounts.map((item) => ({
      name: item.status,
      value: item._count
    }));

    // 3. Project Progress

    const projectProgress = activeProjects.map((p) => {
      const completedTasks = p.tasks.filter((t) => t.status === TASK_STATUS.DONE);
      const loggedMinutes = p.tasks.reduce((s, t) => s + t.timeEntries.reduce((m, e) => m + e.minutes, 0), 0);
      const estimated = p.tasks.reduce((s, t) => s + (t.estimateHours ?? 0), 0);
      const overdue = p.tasks.filter((t) => t.status !== TASK_STATUS.DONE && t.dueDate && t.dueDate < today).length;
      const progress = p.tasks.length ? completedTasks.length / p.tasks.length : 0;
      // Share of the project's time already used; "behind" when work done trails it by more than a quarter
      const span = p.startDate && p.dueDate ? p.dueDate.getTime() - p.startDate.getTime() : 0;
      const elapsed = span > 0 ? Math.min(1, Math.max(0, (Date.now() - p.startDate!.getTime()) / span)) : 0;
      const reasons: string[] = [];
      if (overdue) reasons.push(`${overdue} overdue task${overdue === 1 ? "" : "s"}`);
      if (p.tasks.length && elapsed - progress > 0.25) reasons.push("behind schedule");
      if (estimated > 0 && loggedMinutes / 60 > estimated) reasons.push("over its estimate");
      const health = p.dueDate && p.dueDate < today && progress < 1 ? "overdue" : reasons.length ? "at_risk" : "on_track";
      return {
        id: p.id,
        dueDate: p.dueDate?.toISOString() ?? null,
        overdue,
        health,
        healthReason: health === "overdue" ? "past its deadline" : reasons.join(", "),
        name: p.name,
        completed: completedTasks.length,
        pending: p.tasks.length - completedTasks.length,
        total: p.tasks.length,
        // Estimated vs actual effort (hours, one decimal)
        estimatedHours: Math.round(p.tasks.reduce((s, t) => s + (t.estimateHours ?? 0), 0) * 10) / 10,
        loggedHours: Math.round((loggedMinutes / 60) * 10) / 10
      };
    });

    // 4. Overdue Tasks
    
    const overdueTasks = overdueTasksDb.map(t => ({
      id: t.id,
      title: t.title,
      dueDate: t.dueDate?.toISOString(),
      daysLate: t.dueDate ? differenceInCalendarDays(today, t.dueDate) : 0,
      priority: t.priority,
      project: t.project,
      assignees: t.assignees
    }));

    // 5. Team Workload & Performance
    // To get per-user stats, we need to find assignees within the filtered tasks

    const userStatsMap = new Map<string, { user: any, completed: number, inProgress: number, total: number, overdue: number }>();
    
    for (const task of allRelevantTasks) {
      for (const assignee of task.assignees) {
        // If filtering by member, ignore other assignees on the same task
        if (filters.memberId && isManager && assignee.id !== filters.memberId) continue;

        if (!userStatsMap.has(assignee.id)) {
          userStatsMap.set(assignee.id, { user: assignee, completed: 0, inProgress: 0, total: 0, overdue: 0 });
        }
        const stats = userStatsMap.get(assignee.id)!;
        stats.total++;
        if (task.status === TASK_STATUS.DONE) {
          stats.completed++;
        } else if (task.status === TASK_STATUS.IN_PROGRESS) {
          stats.inProgress++;
        }
        if (task.status !== TASK_STATUS.DONE && task.dueDate && task.dueDate < today) stats.overdue++;
      }
    }
    
    const teamPerformance = Array.from(userStatsMap.values()).sort((a, b) => b.completed - a.completed).slice(0, 10);
    const workloadDistribution = Array.from(userStatsMap.values()).map(u => ({
      id: u.user.id,
      name: u.user.fullName,
      avatarUrl: u.user.avatarUrl,
      taskCount: u.total - u.completed,
      overdue: u.overdue
    })).sort((a, b) => b.taskCount - a.taskCount);

    // 6. Recent Activity

    // 7. KPIs overview
    // The card is labelled "Active Projects"; the overdue list above is capped at 10, so count separately

    return {
      summary,
      kpis: {
        activeProjects: activeProjectCount,
        completedTasks: totalCompletedTasks,
        pendingTasks: totalPendingTasks,
        overdueTasks: totalOverdueTasks,
      },
      trends,
      statusData,
      projectProgress,
      overdueTasks,
      teamPerformance,
      workloadDistribution,
      recentActivity
    };
  }
}
