import { prisma } from "../prisma/client.js";
import {
  MEMBERSHIP_ROLE,
  type MembershipRole,
  type UserRole
} from "../constants/enums.js";
import { ApiError } from "../utils/apiError.js";
import { AuthService } from "./auth.service.js";
import { ActivityService } from "./activity.service.js";

export class TeamService {
  static async list() {
    const users = await prisma.user.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
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

  static async invite(
    actorUserId: string,
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
    const registration = await AuthService.register({
      fullName: input.fullName,
      email: input.email,
      password: input.password,
      role: input.role,
      isInvited: true
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
      include: {
        memberships: {
          where: { removedAt: null, project: { deletedAt: null } },
          include: { project: true }
        }
      }
    });
  }

  static async remove(userId: string, actorUserId: string) {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null }
    });

    if (!user) {
      throw new ApiError(404, "Team member not found");
    }

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

    return { success: true };
  }

  static async update(
    userId: string,
    actorUserId: string,
    input: {
      fullName?: string;
      role?: UserRole;
      title?: string;
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

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        fullName: input.fullName,
        role: input.role,
        title: input.title
      }
    });

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
      include: {
        memberships: {
          where: { removedAt: null, project: { deletedAt: null } },
          include: { project: true }
        }
      }
    });
  }
}
