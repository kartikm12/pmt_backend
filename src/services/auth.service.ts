import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import { USER_ROLE, type UserRole } from "../constants/enums.js";
import { prisma } from "../prisma/client.js";
import { ApiError } from "../utils/apiError.js";
import { PENDING_MESSAGE, SUSPENDED_MESSAGE } from "../middleware/authenticate.js";
import { NotificationService } from "./notification.service.js";
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

    // A removed member keeps their row (soft delete), so a re-invite revives it instead of failing on the unique email
    const canRevive = existingUser?.deletedAt && input.isInvited;
    if (existingUser && !canRevive) {
      throw new ApiError(409, "User with this email already exists");
    }

    const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);
    const data = {
      fullName: input.fullName,
      email: normalizedEmail,
      passwordHash,
      role: userCount === 0 ? USER_ROLE.MANAGER : input.role ?? USER_ROLE.TEAM_MEMBER,
      roleLocked: input.isInvited ? true : false,
      // The very first account runs the workspace; later self sign-ups need a manager's approval
      pendingApproval: userCount > 0 && !input.isInvited
    };

    const user = canRevive
      ? await prisma.user.update({ where: { id: existingUser.id }, data: { ...data, deletedAt: null, title: null } })
      : await prisma.user.create({ data });

    const { passwordHash: _, ...userWithoutPassword } = user;

    await ActivityService.log({
      action: "USER_REGISTERED",
      entityType: "user",
      entityId: user.id,
      description: `${user.fullName} registered`,
      userId: user.id
    });

    if (data.pendingApproval) {
      await this.notifyApprovers(user.fullName, user.email);
      return { pending: true, message: PENDING_MESSAGE, user: { id: user.id, fullName: user.fullName, email: user.email }, token: null };
    }

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

  // Every active company manager hears about a new sign-up
  static async notifyApprovers(fullName: string, email: string) {
    const approvers = await prisma.user.findMany({
      where: { deletedAt: null, pendingApproval: false, status: { not: "SUSPENDED" }, role: { in: [USER_ROLE.MANAGER, USER_ROLE.PROJECT_MANAGER, USER_ROLE.ADMIN] } },
      select: { id: true }
    });
    for (const a of approvers) {
      await NotificationService.create({
        userId: a.id,
        type: "SYSTEM",
        title: "Sign-up waiting for approval",
        message: `${fullName} (${email}) signed up. Approve or reject them on the Team page.`,
        email: true,
        emailLink: "/team"
      }).catch((err) => console.error("Approval notification failed:", err));
    }
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

    // Checked after the password, so only the account owner learns the account is suspended or waiting
    if (user.status === "SUSPENDED") {
      throw new ApiError(403, SUSPENDED_MESSAGE);
    }
    if (user.pendingApproval) {
      throw new ApiError(403, PENDING_MESSAGE);
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

    // Independent bookkeeping, done side by side (each database trip costs ~160 ms live)
    await Promise.all([
      prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() }
      }),
      ActivityService.log({
        action: "USER_LOGGED_IN",
        entityType: "user",
        entityId: user.id,
        description: `${user.fullName} logged in`,
        userId: user.id
      }),
      socketService.forceLogoutSessions(
        session.replacedSessionIds,
        "Your account was logged in from another device."
      )
    ]);

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
      // Your own account is the one place this date is shown
      omit: { passwordChangedAt: false },
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
