import { randomUUID } from "crypto";
import { prisma } from "../prisma/client.js";
import { ApiError } from "../utils/apiError.js";
import { signAccessToken } from "../utils/jwt.js";
export class SessionService {
    static async createSingleActiveSession(user, metadata = {}) {
        const sessionId = randomUUID();
        const { token, expiresAt } = signAccessToken({
            userId: user.id,
            sessionId,
            email: user.email,
            role: user.role,
            fullName: user.fullName
        });
        const existingSessions = await prisma.userSession.findMany({
            where: {
                userId: user.id,
                isActive: true
            },
            select: { id: true }
        });
        await prisma.$transaction([
            prisma.userSession.updateMany({
                where: {
                    userId: user.id,
                    isActive: true
                },
                data: {
                    isActive: false,
                    revokedAt: new Date(),
                    revokedReason: "REPLACED_BY_NEW_LOGIN"
                }
            }),
            prisma.userSession.create({
                data: {
                    id: sessionId,
                    userId: user.id,
                    userAgent: metadata.userAgent,
                    deviceInfo: metadata.deviceInfo ?? metadata.userAgent,
                    ipAddress: metadata.ipAddress,
                    expiresAt
                }
            })
        ]);
        return {
            token,
            sessionId,
            expiresAt,
            replacedSessionIds: existingSessions.map((session) => session.id)
        };
    }
    static async validateActiveSession(sessionId, userId) {
        const session = await prisma.userSession.findFirst({
            where: {
                id: sessionId,
                userId
            }
        });
        if (!session) {
            throw new ApiError(401, "Invalid or expired token");
        }
        if (!session.isActive) {
            throw new ApiError(401, "Session expired. Logged in from another device.");
        }
        if (session.expiresAt <= new Date()) {
            throw new ApiError(401, "Invalid or expired token");
        }
        return session;
    }
    static async invalidateSession(sessionId, reason) {
        await prisma.userSession.updateMany({
            where: {
                id: sessionId,
                isActive: true
            },
            data: {
                isActive: false,
                revokedAt: new Date(),
                revokedReason: reason
            }
        });
    }
}
