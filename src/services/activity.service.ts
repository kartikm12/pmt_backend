import type { InputJsonValue } from "@prisma/client/runtime/library";
import { prisma } from "../prisma/client.js";
import type { ActivityAction } from "../constants/enums.js";

export class ActivityService {
  static async log(params: {
    action: ActivityAction;
    entityType: string;
    entityId: string;
    description: string;
    userId?: string;
    projectId?: string;
    taskId?: string;
    metadata?: InputJsonValue;
  }) {
    return prisma.activityLog.create({
      data: params
    });
  }
}
