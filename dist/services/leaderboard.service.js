import { prisma } from "../prisma/client.js";
import { TASK_STATUS, TASK_PRIORITY, PROJECT_STATUS } from "../constants/enums.js";
import { subDays, startOfDay, isBefore, isAfter } from "date-fns";
export class LeaderboardService {
    static async getSnapshot(filters = {}) {
        const days = filters.days || 30; // Default to 30 days
        const startDate = startOfDay(subDays(new Date(), days));
        const taskWhere = { deletedAt: null };
        const projectWhere = { deletedAt: null };
        if (filters.projectId) {
            taskWhere.projectId = filters.projectId;
            projectWhere.id = filters.projectId;
        }
        // 1. Fetch active users to include in the leaderboard
        const users = await prisma.user.findMany({
            where: {
                deletedAt: null,
                OR: [
                    {
                        assignedTasks: {
                            some: {
                                ...taskWhere,
                                OR: [
                                    { createdAt: { gte: startDate } },
                                    { completedAt: { gte: startDate } },
                                    { status: { not: TASK_STATUS.DONE } }
                                ]
                            }
                        }
                    },
                    {
                        managedProjects: {
                            some: {
                                ...projectWhere,
                                OR: [
                                    { createdAt: { gte: startDate } },
                                    { completedAt: { gte: startDate } },
                                    { status: { not: PROJECT_STATUS.COMPLETED } }
                                ]
                            }
                        }
                    }
                ]
            },
            select: {
                id: true,
                fullName: true,
                avatarUrl: true,
                title: true,
                role: true,
                assignedTasks: {
                    where: {
                        ...taskWhere,
                        OR: [
                            { createdAt: { gte: startDate } },
                            { completedAt: { gte: startDate } },
                            { status: { not: TASK_STATUS.DONE } }
                        ]
                    },
                    select: {
                        id: true,
                        status: true,
                        priority: true,
                        dueDate: true,
                        completedAt: true,
                        createdAt: true
                    }
                },
                managedProjects: {
                    where: {
                        ...projectWhere,
                        OR: [
                            { createdAt: { gte: startDate } },
                            { completedAt: { gte: startDate } },
                            { status: { not: PROJECT_STATUS.COMPLETED } }
                        ]
                    },
                    select: {
                        id: true,
                        status: true,
                        dueDate: true,
                        completedAt: true
                    }
                }
            }
        });
        const leaderboard = users.map(user => {
            let score = 0;
            let completedTasks = 0;
            let inProgressTasks = 0;
            let overdueTasks = 0;
            let onTimeTasks = 0;
            // --- Task Scoring ---
            user.assignedTasks.forEach(task => {
                const isDone = task.status === TASK_STATUS.DONE;
                const isOverdue = !isDone && task.dueDate && isBefore(new Date(task.dueDate), new Date());
                if (isDone && task.completedAt && isAfter(new Date(task.completedAt), startDate)) {
                    completedTasks++;
                    score += 10; // Task completed: +10 pts
                    // On-time check: +5 pts
                    if (task.dueDate && isBefore(new Date(task.completedAt), new Date(task.dueDate))) {
                        onTimeTasks++;
                        score += 5;
                    }
                    // Priority bonus: +10 for Urgent, +5 for High
                    if (task.priority === TASK_PRIORITY.URGENT) {
                        score += 10;
                    }
                    else if (task.priority === TASK_PRIORITY.HIGH) {
                        score += 5;
                    }
                }
                else if (task.status === TASK_STATUS.IN_PROGRESS) {
                    inProgressTasks++;
                }
                if (isOverdue) {
                    overdueTasks++;
                    score -= 5; // Overdue task: -5 pts
                }
            });
            let completedProjects = 0;
            let totalProjects = 0;
            // --- Project Scoring (for Managers) ---
            user.managedProjects.forEach(project => {
                const isDone = project.status === PROJECT_STATUS.COMPLETED;
                const isOverdue = !isDone && project.dueDate && isBefore(new Date(project.dueDate), new Date());
                if (isDone) {
                    totalProjects++;
                    if (project.completedAt && isAfter(new Date(project.completedAt), startDate)) {
                        completedProjects++;
                        score += 100; // Project completed: +100 pts
                        // On-time bonus: +30 pts
                        if (project.dueDate && isBefore(new Date(project.completedAt), new Date(project.dueDate))) {
                            score += 30;
                        }
                    }
                }
                else {
                    totalProjects++;
                    if (isOverdue) {
                        score -= 20; // Overdue projects: -20 pts
                    }
                }
            });
            const totalCompleted = completedTasks + completedProjects;
            const totalItems = completedTasks + inProgressTasks + overdueTasks + totalProjects;
            const productivityScore = totalItems > 0
                ? Math.round((totalCompleted / totalItems) * 100)
                : 0;
            const onTimeRate = completedTasks > 0
                ? Math.round((onTimeTasks / completedTasks) * 100)
                : 0;
            const badges = [];
            if (onTimeRate > 90 && completedTasks > 5)
                badges.push("Fast Finisher");
            if (productivityScore > 80 && totalItems > 5)
                badges.push("Consistent");
            return {
                userId: user.id,
                fullName: user.fullName,
                avatarUrl: user.avatarUrl,
                title: user.title,
                role: user.role,
                completedTasks,
                inProgressTasks,
                overdueTasks,
                productivityScore,
                onTimeRate,
                score: Math.max(0, Math.round(score)),
                badges
            };
        });
        const sortedLeaderboard = leaderboard
            .sort((a, b) => b.score - a.score)
            .map((entry, index) => {
            const entryWithRank = { ...entry, rank: index + 1 };
            if (entryWithRank.rank === 1 && entryWithRank.score > 0) {
                entryWithRank.badges.push("Top Performer");
            }
            return entryWithRank;
        });
        return sortedLeaderboard;
    }
}
