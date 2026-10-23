import { Prisma } from "@prisma/client";
import { prisma } from "../prisma/client.js";
import { TASK_STATUS, TASK_PRIORITY, PROJECT_STATUS } from "../constants/enums.js";
import { subDays, addDays, startOfDay, startOfToday, isBefore, isAfter } from "date-fns";
import { LIVE_PROJECT_STATUSES, type ProjectStatus } from "../constants/enums.js";

// Deadlines are dates (stored as that day's 00:00): work is overdue only once the day is over,
// and finishing any time on the due day counts as on time, as everywhere else in the app
const isPastDue = (due: Date) => isBefore(due, startOfToday());
const finishedInTime = (completedAt: Date, due: Date) => isBefore(completedAt, addDays(startOfDay(due), 1));

export class LeaderboardService {
  static async getSnapshot(filters: { days?: number; projectId?: string } = {}) {
    const days = filters.days || 30; // Default to 30 days
    const startDate = startOfDay(subDays(new Date(), days));

    const taskWhere: any = { deletedAt: null };
    const projectWhere: any = { deletedAt: null };

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
        role: true
      }
    });

    // Speed: each person's tasks and projects used to be nested into this query, and building those nested
    // objects was most of the time. The same rows now come as flat lists in the same trip and are matched up here.
    const taskWindow = { ...taskWhere, OR: [{ createdAt: { gte: startDate } }, { completedAt: { gte: startDate } }, { status: { not: TASK_STATUS.DONE } }] };
    const [tasks, links, projectStatuses, managed] = await Promise.all([
      prisma.task.findMany({ where: taskWindow, select: { id: true, status: true, priority: true, dueDate: true, completedAt: true, createdAt: true, projectId: true } }),
      prisma.$queryRaw<{ taskId: string; userId: string }[]>`
        SELECT ta."A" AS "taskId", ta."B" AS "userId" FROM "_TaskAssignees" ta JOIN "Task" t ON t."id" = ta."A"
        WHERE t."deletedAt" IS NULL ${filters.projectId ? Prisma.sql`AND t."projectId" = ${filters.projectId}` : Prisma.empty}`,
      prisma.project.findMany({ where: filters.projectId ? { id: filters.projectId } : {}, select: { id: true, status: true } }),
      prisma.project.findMany({
        where: { ...projectWhere, OR: [{ createdAt: { gte: startDate } }, { completedAt: { gte: startDate } }, { status: { not: PROJECT_STATUS.COMPLETED } }] },
        select: { id: true, status: true, dueDate: true, completedAt: true, managerId: true }
      })
    ]);
    const statusOf = new Map(projectStatuses.map((p) => [p.id, p.status]));
    const taskById = new Map(tasks.map((t) => [t.id, { ...t, project: { status: statusOf.get(t.projectId)! } }]));
    const tasksOf = new Map<string, (typeof tasks[number] & { project: { status: string } })[]>();
    for (const l of links) {
      const t = taskById.get(l.taskId);
      if (t) (tasksOf.get(l.userId) ?? tasksOf.set(l.userId, []).get(l.userId)!).push(t);
    }
    const projectsOf = new Map<string, typeof managed>();
    for (const p of managed) (projectsOf.get(p.managerId) ?? projectsOf.set(p.managerId, []).get(p.managerId)!).push(p);

    const leaderboard = users.map(person => {
      const user = { ...person, assignedTasks: tasksOf.get(person.id) ?? [], managedProjects: projectsOf.get(person.id) ?? [] };
      let score = 0;
      let completedTasks = 0;
      let inProgressTasks = 0;
      let overdueTasks = 0;
      let onTimeTasks = 0;

      // --- Task Scoring ---
      user.assignedTasks.forEach(task => {
        const isDone = task.status === TASK_STATUS.DONE;
        // Work in paused, finished or cancelled projects isn't held against anyone
        const isOverdue = !isDone && task.dueDate && isPastDue(new Date(task.dueDate)) && LIVE_PROJECT_STATUSES.includes(task.project.status as ProjectStatus);

        if (isDone && task.completedAt && isAfter(new Date(task.completedAt), startDate)) {
          completedTasks++;
          
          score += 10; // Task completed: +10 pts

          // On-time check: +5 pts
          if (task.dueDate && finishedInTime(new Date(task.completedAt), new Date(task.dueDate))) {
            onTimeTasks++;
            score += 5;
          }

          // Priority bonus: +10 for Urgent, +5 for High
          if (task.priority === TASK_PRIORITY.URGENT) {
            score += 10;
          } else if (task.priority === TASK_PRIORITY.HIGH) {
            score += 5;
          }
        } else if (task.status === TASK_STATUS.IN_PROGRESS) {
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
        const isOverdue = !isDone && project.dueDate && isPastDue(new Date(project.dueDate)) && LIVE_PROJECT_STATUSES.includes(project.status as ProjectStatus);

        if (isDone) {
          totalProjects++;
          if (project.completedAt && isAfter(new Date(project.completedAt), startDate)) {
            completedProjects++;
            score += 100; // Project completed: +100 pts

            // On-time bonus: +30 pts
            if (project.dueDate && finishedInTime(new Date(project.completedAt), new Date(project.dueDate))) {
              score += 30;
            }
          }
        } else {
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
      if (onTimeRate > 90 && completedTasks > 5) badges.push("Fast Finisher");
      if (productivityScore > 80 && totalItems > 5) badges.push("Consistent");

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

    // Equal scores are ordered by name, so ranks don't depend on the order people happened to load in
    const sortedLeaderboard = leaderboard
      .sort((a, b) => b.score - a.score || a.fullName.localeCompare(b.fullName))
      // Equal scores share a rank (1, 1, 3), so nobody is placed above someone with the same points
      .map((entry, _index, all) => {
        const entryWithRank = { ...entry, rank: 1 + all.filter((o) => o.score > entry.score).length };
        if (entryWithRank.rank === 1 && entryWithRank.score > 0) {
          entryWithRank.badges.push("Top Performer");
        }
        return entryWithRank;
      });

    return sortedLeaderboard;
  }
}
