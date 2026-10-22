import { startOfToday, startOfWeek } from "date-fns";
import { prisma } from "../prisma/client.js";
import type { UserRole } from "../constants/enums.js";
import { ProjectService } from "./project.service.js";
import { LIVE_PROJECT_STATUSES, type ProjectStatus } from "../constants/enums.js";

const LIMIT = 8;

export class SearchService {
  // Ctrl+K: tasks and projects the person can already see, plus teammates (the team list is open to all)
  static async search(q: string, userId: string, role: UserRole) {
    const term = q.trim();
    if (term.length < 2) return { tasks: [], projects: [], people: [] };
    const contains = { contains: term, mode: "insensitive" as const };
    const seesAll = ProjectService.isManagerRole(role);
    const memberOf = { members: { some: { userId, removedAt: null } } };

    const [tasks, projects, people] = await Promise.all([
      prisma.task.findMany({
        where: {
          deletedAt: null,
          project: { deletedAt: null },
          OR: [{ title: contains }, { description: contains }, { labels: { has: term.toLowerCase() } }],
          ...(seesAll ? {} : { AND: [{ OR: [{ assignees: { some: { id: userId } } }, { project: memberOf }] }] })
        },
        select: { id: true, title: true, status: true, project: { select: { id: true, name: true } } },
        orderBy: { updatedAt: "desc" },
        take: LIMIT
      }),
      prisma.project.findMany({
        where: {
          deletedAt: null,
          OR: [{ name: contains }, { description: contains }],
          ...(seesAll ? {} : { AND: [{ OR: [memberOf, { tasks: { some: { deletedAt: null, assignees: { some: { id: userId } } } } }] }] })
        },
        select: { id: true, name: true, status: true },
        orderBy: { updatedAt: "desc" },
        take: LIMIT
      }),
      prisma.user.findMany({
        where: { deletedAt: null, pendingApproval: false, OR: [{ fullName: contains }, { email: contains }, { title: contains }] },
        select: { id: true, fullName: true, email: true, title: true, avatarUrl: true },
        orderBy: { fullName: "asc" },
        take: LIMIT
      })
    ]);
    return { tasks, projects, people };
  }

  // Workload: open work per active person, with estimated hours and this week's logged hours
  static async workload() {
    const today = startOfToday();
    const weekStart = startOfWeek(today, { weekStartsOn: 1 });
    const users = await prisma.user.findMany({
      where: { deletedAt: null, pendingApproval: false, status: { not: "SUSPENDED" } },
      select: {
        id: true,
        fullName: true,
        title: true,
        avatarUrl: true,
        assignedTasks: {
          where: { deletedAt: null, status: { not: "DONE" }, project: { deletedAt: null } },
          select: { dueDate: true, estimateHours: true, project: { select: { status: true } } }
        },
        timeEntries: { where: { spentOn: { gte: weekStart }, task: { deletedAt: null, project: { deletedAt: null } } }, select: { minutes: true } }
      }
    });
    return users
      .map((u) => ({
        userId: u.id,
        fullName: u.fullName,
        title: u.title,
        avatarUrl: u.avatarUrl,
        openTasks: u.assignedTasks.length,
        overdueTasks: u.assignedTasks.filter((t) => t.dueDate && t.dueDate < today && LIVE_PROJECT_STATUSES.includes(t.project.status as ProjectStatus)).length,
        estimatedHours: Math.round(u.assignedTasks.reduce((s, t) => s + (t.estimateHours ?? 0), 0) * 10) / 10,
        loggedHoursThisWeek: Math.round((u.timeEntries.reduce((s, e) => s + e.minutes, 0) / 60) * 10) / 10
      }))
      .sort((a, b) => b.openTasks - a.openTasks || b.estimatedHours - a.estimatedHours);
  }
}
