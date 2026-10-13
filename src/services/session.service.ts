import { randomUUID } from "crypto";
import { prisma } from "../prisma/client.js";
import { ApiError } from "../utils/apiError.js";
import { signAccessToken } from "../utils/jwt.js";

type SessionMetadata = {
  userAgent?: string;
  ipAddress?: string;
  deviceInfo?: string;
};

export class SessionService {
  static async createSingleActiveSession(
    user: {
      id: string;
      email: string;
      role: Express.UserPayload["role"];
      fullName: string;
    },
    metadata: SessionMetadata = {}
  ) {
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

  static async validateActiveSession(sessionId: string, userId: string) {
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
      // Say why the session ended; "another device" is only true for a replaced login
      const reasons: Record<string, string> = {
        REPLACED_BY_NEW_LOGIN: "Session expired. Logged in from another device.",
        USER_SUSPENDED: "Your account is suspended. Contact your manager.",
        USER_REMOVED: "Your account has been removed from the workspace."
      };
      throw new ApiError(401, reasons[session.revokedReason ?? ""] ?? "Invalid or expired token");
    }

    if (session.expiresAt <= new Date()) {
      throw new ApiError(401, "Invalid or expired token");
    }

    return session;
  }

  static async invalidateSession(sessionId: string, reason: string) {
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
