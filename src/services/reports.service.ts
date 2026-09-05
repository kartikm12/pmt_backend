import { prisma } from "../prisma/client.js";
import { PROJECT_STATUS, TASK_STATUS } from "../constants/enums.js";
import { startOfDay, startOfToday, subDays, format } from "date-fns";

const MANAGER_ROLES = ["ADMIN", "MANAGER", "PROJECT_MANAGER"];

export class ReportsService {
  static async getComprehensiveReport(userId: string, role: string, filters: { days?: number, projectId?: string, memberId?: string } = {}) {
    const daysCount = filters.days || 7;
    const isManager = MANAGER_ROLES.includes(role);

    const taskBaseWhere: any = { deletedAt: null };
    const projectBaseWhere: any = { deletedAt: null };
    const activityBaseWhere: any = {};

    if (!isManager) {
      taskBaseWhere.assignees = { some: { id: userId } };
      projectBaseWhere.members = { some: { userId } };
      // Normal users only see their own activities or activities on tasks/projects they are part of.
      activityBaseWhere.OR = [
        { userId: userId },
        { task: { assignees: { some: { id: userId } } } },
        { project: { members: { some: { userId } } } }
      ];
    }

    if (filters.projectId) {
      taskBaseWhere.projectId = filters.projectId;
      projectBaseWhere.id = filters.projectId;
      activityBaseWhere.projectId = filters.projectId;
    }
    if (filters.memberId) {
      taskBaseWhere.assignees = { some: { id: filters.memberId } };
      projectBaseWhere.members = { some: { userId: filters.memberId } };
      activityBaseWhere.userId = filters.memberId;
    }

    // 1. Completion Trends
    const days = Array.from({ length: daysCount }).map((_, i) => {
      const date = subDays(new Date(), (daysCount - 1) - i);
      return {
        start: startOfDay(date),
        end: new Date(date.getTime() + (24 * 60 * 60 * 1000) - 1),
        label: daysCount > 7 ? format(date, "MMM d") : format(date, "EEE")
      };
    });

    const startRange = days[0].start;
    const endRange = days[days.length - 1].end;

    const tasksInRange = await prisma.task.findMany({
      where: {
        ...taskBaseWhere,
        OR: [
          { createdAt: { gte: startRange, lte: endRange } },
          { completedAt: { gte: startRange, lte: endRange } }
        ]
      },
      select: { status: true, createdAt: true, completedAt: true }
    });

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

    // 2. Tasks by Status
    const statusCounts = await prisma.task.groupBy({
      by: ["status"],
      where: taskBaseWhere,
      _count: true
    });

    const statusData = statusCounts.map((item) => ({
      name: item.status,
      value: item._count
    }));

    // 3. Project Progress
    const activeProjects = await prisma.project.findMany({
      where: { ...projectBaseWhere, status: PROJECT_STATUS.ACTIVE },
      include: {
        tasks: { where: taskBaseWhere }
      }
    });

    const projectProgress = activeProjects.map((p) => {
      const completedTasks = p.tasks.filter((t) => t.status === TASK_STATUS.DONE);
      return {
        name: p.name,
        completed: completedTasks.length,
        pending: p.tasks.length - completedTasks.length,
        total: p.tasks.length
      };
    });

    // 4. Overdue Tasks
    const overdueTasksDb = await prisma.task.findMany({
      where: {
        ...taskBaseWhere,
        status: { not: TASK_STATUS.DONE },
        dueDate: { lt: startOfToday() }
      },
      include: {
        assignees: { select: { fullName: true, avatarUrl: true } }
      },
      orderBy: { dueDate: 'asc' },
      take: 10
    });
    
    const overdueTasks = overdueTasksDb.map(t => ({
      id: t.id,
      title: t.title,
      dueDate: t.dueDate?.toISOString(),
      priority: t.priority,
      assignees: t.assignees
    }));

    // 5. Team Workload & Performance
    // To get per-user stats, we need to find assignees within the filtered tasks
    const allRelevantTasks = await prisma.task.findMany({
      where: taskBaseWhere,
      include: {
        assignees: { select: { id: true, fullName: true, avatarUrl: true } }
      }
    });

    const userStatsMap = new Map<string, { user: any, completed: number, inProgress: number, total: number }>();
    
    for (const task of allRelevantTasks) {
      for (const assignee of task.assignees) {
        // If filtering by member, ignore other assignees on the same task
        if (filters.memberId && assignee.id !== filters.memberId) continue;

        if (!userStatsMap.has(assignee.id)) {
          userStatsMap.set(assignee.id, { user: assignee, completed: 0, inProgress: 0, total: 0 });
        }
        const stats = userStatsMap.get(assignee.id)!;
        stats.total++;
        if (task.status === TASK_STATUS.DONE) {
          stats.completed++;
        } else if (task.status === TASK_STATUS.IN_PROGRESS) {
          stats.inProgress++;
        }
      }
    }
    
    const teamPerformance = Array.from(userStatsMap.values()).sort((a, b) => b.completed - a.completed).slice(0, 10);
    const workloadDistribution = Array.from(userStatsMap.values()).map(u => ({
      name: u.user.fullName,
      taskCount: u.total - u.completed
    })).sort((a, b) => b.taskCount - a.taskCount);

    // 6. Recent Activity
    const recentActivity = await prisma.activityLog.findMany({
      where: activityBaseWhere,
      include: {
        user: { select: { fullName: true, avatarUrl: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    // 7. KPIs overview
    const totalProjects = await prisma.project.count({ where: projectBaseWhere });
    const totalCompletedTasks = await prisma.task.count({ where: { ...taskBaseWhere, status: TASK_STATUS.DONE } });
    const totalPendingTasks = await prisma.task.count({ where: { ...taskBaseWhere, status: { not: TASK_STATUS.DONE } } });
    const totalOverdueTasks = overdueTasksDb.length;

    return {
      kpis: {
        activeProjects: totalProjects,
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
