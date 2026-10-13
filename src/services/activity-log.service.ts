import { prisma } from "../prisma/client.js";

export class ActivityLogService {
  static async list(filters: { projectId?: string; taskId?: string; userId?: string; limit?: number; skip?: number; scope?: object }) {
    return prisma.activityLog.findMany({
      where: {
        projectId: filters.projectId,
        taskId: filters.taskId,
        userId: filters.userId,
        ...filters.scope
      },
      include: {
        user: {
          select: { id: true, fullName: true, avatarUrl: true }
        },
        project: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: "desc" },
      take: filters.limit ?? 50,
      skip: filters.skip ?? 0
    });
  }
}
