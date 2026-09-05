import { prisma } from "../prisma/client.js";
import { PROJECT_STATUS, TASK_STATUS, USER_ROLE } from "../constants/enums.js";
import { startOfToday } from "date-fns";
export class DashboardService {
    static async getStats(userId, role) {
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
        const [activeProjectsCount, totalProjectsCount, pendingProjectsCount, completedProjectsCount, pendingTasksCount, completedTasksCount, totalTasksCount, overdueTasksCount] = await Promise.all([
            prisma.project.count({ where: { status: PROJECT_STATUS.ACTIVE, ...projectWhere } }),
            prisma.project.count({ where: projectWhere }),
            prisma.project.count({ where: { status: { in: [PROJECT_STATUS.PLANNING, PROJECT_STATUS.ON_HOLD] }, ...projectWhere } }),
            prisma.project.count({ where: { status: PROJECT_STATUS.COMPLETED, ...projectWhere } }),
            prisma.task.count({ where: { status: { not: TASK_STATUS.DONE }, ...taskWhere } }),
            prisma.task.count({ where: { status: TASK_STATUS.DONE, ...taskWhere } }),
            prisma.task.count({ where: taskWhere }),
            prisma.task.count({
                where: {
                    status: { not: TASK_STATUS.DONE },
                    dueDate: { lt: startOfToday() },
                    ...taskWhere
                }
            })
        ]);
        const recentTasks = await prisma.task.findMany({
            where: taskWhere,
            orderBy: { createdAt: "desc" },
            take: 5,
            include: {
                project: { select: { id: true, name: true } }
            }
        });
        const upcomingDeadlines = await prisma.task.findMany({
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
        });
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
