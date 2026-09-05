import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import { USER_ROLE, type UserRole } from "../constants/enums.js";
import { prisma } from "../prisma/client.js";
import { ApiError } from "../utils/apiError.js";
import { ActivityService } from "./activity.service.js";
import { SessionService } from "./session.service.js";
import { socketService } from "./socket.service.js";

export class AuthService {
  static async register(input: {
    fullName: string;
    email: string;
    password: string;
    role?: UserRole;
    isInvited?: boolean;
  }, metadata?: { userAgent?: string; ipAddress?: string }) {
    const userCount = await prisma.user.count({
      where: { deletedAt: null }
    });

    const normalizedEmail = input.email.toLowerCase();
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    if (existingUser) {
      throw new ApiError(409, "User with this email already exists");
    }

    const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);

    const user = await prisma.user.create({
      data: {
        fullName: input.fullName,
        email: normalizedEmail,
        passwordHash,
        role: userCount === 0 ? USER_ROLE.MANAGER : input.role ?? USER_ROLE.TEAM_MEMBER,
        // @ts-ignore
        roleLocked: input.isInvited ? true : false
      }
    });

    const { passwordHash: _, ...userWithoutPassword } = user;

    await ActivityService.log({
      action: "USER_REGISTERED",
      entityType: "user",
      entityId: user.id,
      description: `${user.fullName} registered`,
      userId: user.id
    });

    const session = input.isInvited
      ? null
      : await SessionService.createSingleActiveSession(
          {
            id: user.id,
            role: user.role,
            email: user.email,
            fullName: user.fullName
          },
          metadata
        );

    return { user: { ...userWithoutPassword, roleLocked: (user as any).roleLocked }, token: session?.token ?? null };
  }

  static async login(input: { email: string; password: string }, metadata?: { userAgent?: string; ipAddress?: string }) {
    const normalizedEmail = input.email.toLowerCase();

    const user = await prisma.user.findFirst({
      where: {
        email: normalizedEmail,
        deletedAt: null
      }
    });

    if (!user) {
      throw new ApiError(401, "Invalid email or password");
    }

    const isPasswordValid = await bcrypt.compare(input.password, user.passwordHash);

    if (!isPasswordValid) {
      throw new ApiError(401, "Invalid email or password");
    }

    const session = await SessionService.createSingleActiveSession(
      {
        id: user.id,
        role: user.role,
        email: user.email,
        fullName: user.fullName
      },
      metadata
    );

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    });

    await ActivityService.log({
      action: "USER_LOGGED_IN",
      entityType: "user",
      entityId: user.id,
      description: `${user.fullName} logged in`,
      userId: user.id
    });

    await socketService.forceLogoutSessions(
      session.replacedSessionIds,
      "Your account was logged in from another device."
    );

    return {
      token: session.token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        roleLocked: (user as any).roleLocked,
        avatarUrl: user.avatarUrl,
        status: user.status
      }
    };
  }

  static async me(userId: string) {
    const user = await prisma.user.findFirst({
      where: {
        id: userId,
        deletedAt: null
      },
      include: {
        memberships: {
          where: { removedAt: null, project: { deletedAt: null } },
          include: { project: true }
        },
        assignedTasks: {
          where: { deletedAt: null, project: { deletedAt: null } },
          select: { project: true }
        }
      }
    });

    if (!user) throw new ApiError(404, "User not found");

    const projectMap = new Map();
    user.memberships.forEach(m => projectMap.set(m.project.id, m.project));
    user.assignedTasks.forEach(t => projectMap.set(t.project.id, t.project));

    const mergedMemberships = Array.from(projectMap.values()).map(p => ({ project: p }));
    const { assignedTasks, passwordHash, ...rest } = user;
    return { ...rest, roleLocked: (user as any).roleLocked, memberships: mergedMemberships };
  }

  static async logout(sessionId: string) {
    await SessionService.invalidateSession(sessionId, "USER_LOGOUT");
    return { success: true };
  }
}
