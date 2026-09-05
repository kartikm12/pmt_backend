import { prisma } from "../prisma/client.js";
export class ActivityService {
    static async log(params) {
        return prisma.activityLog.create({
            data: params
        });
    }
}
