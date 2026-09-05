import { prisma } from "../prisma/client.js";

export class ActivityLogService {
  static async list(filters: { projectId?: string; taskId?: string; userId?: string; limit?: number }) {
    return prisma.activityLog.findMany({
      where: {
        projectId: filters.projectId,
        taskId: filters.taskId,
        userId: filters.userId
      },
      include: {
        user: {
          select: { id: true, fullName: true, avatarUrl: true }
        }
      },
      orderBy: { createdAt: "desc" },
      take: filters.limit ?? 50
    });
  }
}
