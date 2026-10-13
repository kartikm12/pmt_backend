import { prisma } from "../prisma/client.js";
import {
  MEMBERSHIP_ROLE,
  USER_ROLE,
  type MembershipRole,
  type UserRole
} from "../constants/enums.js";
import { ApiError } from "../utils/apiError.js";
import { socketService } from "./socket.service.js";
import { AuthService } from "./auth.service.js";
import { ActivityService } from "./activity.service.js";
import { MailService } from "../mail/mail.service.js";

export class TeamService {
  static async list() {
    const users = await prisma.user.findMany({
      where: { deletedAt: null, pendingApproval: false },
      orderBy: { createdAt: "desc" },
      omit: { passwordHash: true },
      include: {
        memberships: {
          where: { removedAt: null, project: { deletedAt: null } },
          include: {
            project: {
              select: { id: true, name: true, slug: true, status: true }
            }
          }
        },
        assignedTasks: {
          where: { deletedAt: null, project: { deletedAt: null } },
          select: {
            project: {
              select: { id: true, name: true, slug: true, status: true }
            }
          }
        },
        _count: {
          select: { assignedTasks: true }
        }
      }
    });

    return users.map(user => {
      const projectMap = new Map();
      user.memberships.forEach(m => projectMap.set(m.project.id, m.project));
      user.assignedTasks.forEach(t => projectMap.set(t.project.id, t.project));
      
      const mergedMemberships = Array.from(projectMap.values()).map(p => ({ project: p }));
      const { assignedTasks, ...rest } = user;
      return { ...rest, memberships: mergedMemberships };
    });
  }

  static async listPending() {
    return prisma.user.findMany({
      where: { deletedAt: null, pendingApproval: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, fullName: true, email: true, createdAt: true }
    });
  }

  static async findPending(userId: string) {
    const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null, pendingApproval: true } });
    if (!user) throw new ApiError(404, "This sign-up was already handled or no longer exists");
    return user;
  }

  static async approve(userId: string, role: UserRole, actor: { userId: string; role: UserRole; fullName?: string }) {
    const user = await this.findPending(userId);
    this.assertCanManage(actor.role, undefined, role);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { pendingApproval: false, role, status: "ACTIVE" },
      omit: { passwordHash: true }
    });
    void MailService.send({
      to: user.email,
      subject: "Your PMT account is approved",
      heading: "You're in",
      body: `Hi ${user.fullName},\n\n${actor.fullName ?? "A manager"} approved your account. You can sign in now with the email and password you signed up with.`,
      button: { label: "Sign in", url: MailService.appUrl("/login") }
    });
    await ActivityService.log({
      action: "TEAM_MEMBER_INVITED",
      entityType: "user",
      entityId: user.id,
      description: `${actor.fullName ?? "A manager"} approved ${user.fullName}'s sign-up`,
      userId: actor.userId
    });
    return updated;
  }

  // A rejected sign-up never used the app, so it is removed outright and the email can apply again
  static async reject(userId: string, actor: { userId: string; fullName?: string }) {
    const user = await this.findPending(userId);
    await prisma.user.delete({ where: { id: user.id } });
    await ActivityService.log({
      action: "TEAM_MEMBER_REMOVED",
      entityType: "user",
      entityId: user.id,
      description: `${actor.fullName ?? "A manager"} rejected ${user.fullName}'s sign-up (${user.email})`,
      userId: actor.userId
    });
  }

  // Only an Admin may grant the Admin role or change/remove an Admin's account
  static assertCanManage(actorRole: UserRole, targetRole?: UserRole, newRole?: UserRole) {
    if (actorRole === USER_ROLE.ADMIN) return;
    if (targetRole === USER_ROLE.ADMIN || newRole === USER_ROLE.ADMIN) {
      throw new ApiError(403, "Only an Admin can manage Admin accounts");
    }
  }

  static async assertProjectExists(projectId: string) {
    const project = await prisma.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { id: true } });
    if (!project) throw new ApiError(400, "Selected project does not exist");
  }

  static async invite(
    actorUserId: string,
    actorRole: UserRole,
    input: {
      fullName: string;
      email: string;
      password: string;
      role?: UserRole;
      title?: string;
      projectId?: string;
      membershipRole?: MembershipRole;
    }
  ) {
    this.assertCanManage(actorRole, undefined, input.role);
    if (input.projectId) await this.assertProjectExists(input.projectId);

    const registration = await AuthService.register({
      fullName: input.fullName,
      email: input.email,
      password: input.password,
      role: input.role,
      isInvited: true
    });

    // Welcome email. The temporary password is never emailed: the manager hands it over in person
    void MailService.send({
      to: registration.user.email,
      subject: "You've been added to PMT",
      heading: "Welcome to PMT",
      body: `Hi ${registration.user.fullName},\n\nYou've been added to the team on PMT, Entro Labs' project tool. Your manager will give you a temporary password; sign in with this email address and change it in Settings.`,
      button: { label: "Sign in", url: MailService.appUrl("/login") }
    });

    if (input.title) {
      await prisma.user.update({
        where: { id: registration.user.id },
        data: { title: input.title }
      });
    }

    if (input.projectId) {
      await prisma.projectMember.upsert({
        where: {
          projectId_userId: { projectId: input.projectId, userId: registration.user.id }
        },
        update: {
          removedAt: null,
          role: input.membershipRole ?? MEMBERSHIP_ROLE.CONTRIBUTOR
        },
        create: {
          projectId: input.projectId,
          userId: registration.user.id,
          role: input.membershipRole ?? MEMBERSHIP_ROLE.CONTRIBUTOR
        }
      });
    }

    await ActivityService.log({
      action: "TEAM_MEMBER_INVITED",
      entityType: "user",
      entityId: registration.user.id,
      description: `Invited team member ${registration.user.fullName}`,
      userId: actorUserId,
      metadata: { projectId: input.projectId }
    });

    return prisma.user.findUnique({
      where: { id: registration.user.id },
      omit: { passwordHash: true },
      include: {
        memberships: {
          where: { removedAt: null, project: { deletedAt: null } },
          include: { project: true }
        }
      }
    });
  }

  static async remove(userId: string, actorUserId: string, actorRole: UserRole) {
    if (userId === actorUserId) {
      throw new ApiError(400, "You cannot remove yourself from the team");
    }

    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null }
    });

    if (!user) {
      throw new ApiError(404, "Team member not found");
    }

    this.assertCanManage(actorRole, user.role);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { deletedAt: new Date() }
      }),
      prisma.projectMember.updateMany({
        where: { userId, removedAt: null },
        data: { removedAt: new Date() }
      })
    ]);

    await ActivityService.log({
      action: "TEAM_MEMBER_REMOVED",
      entityType: "user",
      entityId: userId,
      description: `Removed team member ${user.fullName}`,
      userId: actorUserId
    });

    await this.endSessions(userId, "USER_REMOVED", "Your account has been removed from the workspace.");

    return { success: true };
  }

  // Revoke every open session and push open tabs back to the login page with the reason
  static async endSessions(userId: string, reason: string, message: string) {
    const activeSessions = await prisma.userSession.findMany({ where: { userId, isActive: true }, select: { id: true } });
    await prisma.userSession.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false, revokedAt: new Date(), revokedReason: reason }
    });
    await socketService.forceLogoutSessions(activeSessions.map((s) => s.id), message);
  }

  static async update(
    userId: string,
    actorUserId: string,
    actorRole: UserRole,
    input: {
      fullName?: string;
      role?: UserRole;
      title?: string;
      status?: "ACTIVE" | "SUSPENDED";
      projectId?: string;
      membershipRole?: MembershipRole;
    }
  ) {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null }
    });

    if (!user) {
      throw new ApiError(404, "Team member not found");
    }

    if (userId === actorUserId && input.role && input.role !== user.role) {
      throw new ApiError(400, "You cannot change your own role");
    }
    if (userId === actorUserId && input.status && input.status !== user.status) {
      throw new ApiError(400, "You cannot suspend yourself");
    }
    this.assertCanManage(actorRole, user.role, input.role);
    if (input.projectId) await this.assertProjectExists(input.projectId);

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        fullName: input.fullName,
        role: input.role,
        title: input.title,
        status: input.status
      }
    });

    if (input.status === "SUSPENDED" && user.status !== "SUSPENDED") {
      await this.endSessions(userId, "USER_SUSPENDED", "Your account has been suspended. Contact your manager.");
    }

    if (input.projectId !== undefined) {
      // Remove from other projects if it's a "set" rather than "add"
      // But typically, we just primary-assign. 
      // If we want to allow multiple, we'd need a different UI.
      // For this simple PMT, we'll upsert into the provided projectId.
      
      if (input.projectId) {
        await prisma.projectMember.upsert({
          where: {
            projectId_userId: { projectId: input.projectId, userId }
          },
          update: {
            removedAt: null,
            role: input.membershipRole ?? MEMBERSHIP_ROLE.CONTRIBUTOR
          },
          create: {
            projectId: input.projectId,
            userId,
            role: input.membershipRole ?? MEMBERSHIP_ROLE.CONTRIBUTOR
          }
        });
      }
    }

    await ActivityService.log({
      action: "PROFILE_UPDATED",
      entityType: "user",
      entityId: userId,
      description: `Updated details for ${updatedUser.fullName}`,
      userId: actorUserId,
      metadata: input
    });

    return prisma.user.findUnique({
      where: { id: userId },
      omit: { passwordHash: true },
      include: {
        memberships: {
          where: { removedAt: null, project: { deletedAt: null } },
          include: { project: true }
        }
      }
    });
  }
}
