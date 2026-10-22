import { prisma } from "../prisma/client.js";
import { PROJECT_STATUS, TASK_STATUS, USER_ROLE, type UserRole } from "../constants/enums.js";
import { startOfToday } from "date-fns";
import { NOT_IN_PAUSED_PROJECT } from "../constants/enums.js";

export class DashboardService {
  static async getStats(userId: string, role: UserRole) {
    const isManager = role === USER_ROLE.MANAGER || role === USER_ROLE.PROJECT_MANAGER || role === USER_ROLE.ADMIN;

    const taskWhere = isManager ? { deletedAt: null } : {
      deletedAt: null,
      assignees: { some: { id: userId } }
    };

    const projectWhere = isManager ? { deletedAt: null } : {
      deletedAt: null,
      OR: [
        { members: { some: { userId, removedAt: null } } },
        { tasks: { some: { deletedAt: null, assignees: { some: { id: userId } } } } }
      ]
    };

    // Projects and tasks are each counted once, grouped by status (was seven separate counts)
    const [
      projectsByStatus,
      tasksByStatus,
      overdueTasksCount,
      recentTasks,
      upcomingDeadlines
    ] = await Promise.all([
      prisma.project.groupBy({ by: ["status"], where: projectWhere, _count: { _all: true } }),
      prisma.task.groupBy({ by: ["status"], where: taskWhere, _count: { _all: true } }),
      prisma.task.count({
        where: {
          status: { not: TASK_STATUS.DONE },
          dueDate: { lt: startOfToday() },
          ...taskWhere,
          ...NOT_IN_PAUSED_PROJECT
        }
      }),
      prisma.task.findMany({
        where: taskWhere,
        orderBy: { createdAt: "desc" },
        take: 5,
        include: {
          project: { select: { id: true, name: true } }
        }
      }),
      prisma.task.findMany({
        where: {
          status: { not: TASK_STATUS.DONE },
          dueDate: { gte: startOfToday() },
          ...taskWhere
        },
        orderBy: { dueDate: "asc" },
        take: 5,
        include: {
          project: { select: { id: true, name: true } }
        }
      })
    ]);

    const projects = (statuses?: string[]) => projectsByStatus.filter((g) => !statuses || statuses.includes(g.status)).reduce((n, g) => n + g._count._all, 0);
    const tasks = (keep: (status: string) => boolean) => tasksByStatus.filter((g) => keep(g.status)).reduce((n, g) => n + g._count._all, 0);
    const activeProjectsCount = projects([PROJECT_STATUS.ACTIVE]);
    const totalProjectsCount = projects();
    const pendingProjectsCount = projects([PROJECT_STATUS.PLANNING, PROJECT_STATUS.ON_HOLD]);
    const completedProjectsCount = projects([PROJECT_STATUS.COMPLETED]);
    const pendingTasksCount = tasks((s) => s !== TASK_STATUS.DONE);
    const completedTasksCount = tasks((s) => s === TASK_STATUS.DONE);
    const totalTasksCount = tasks(() => true);

    return {
      stats: {
        activeProjects: activeProjectsCount,
        totalProjects: totalProjectsCount,
        pendingProjects: pendingProjectsCount,
        completedProjects: completedProjectsCount,
        pendingTasks: pendingTasksCount,
        completedTasks: completedTasksCount,
        totalTasks: totalTasksCount,
        overdueTasks: overdueTasksCount
      },
      recentTasks,
      upcomingDeadlines
    };
  }
}
