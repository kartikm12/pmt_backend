import {
  MEMBERSHIP_ROLE,
  PROJECT_STATUS,
  USER_ROLE,
  type UserRole,
  type MembershipRole,
  type ProjectStatus
} from "../constants/enums.js";
import { prisma } from "../prisma/client.js";
import { ApiError } from "../utils/apiError.js";
import { createSlug } from "../utils/slug.js";
import { ActivityService } from "./activity.service.js";
import { NotificationService } from "./notification.service.js";
import { socketService } from "./socket.service.js";
import { generateShortId } from "../utils/id.js";

export class ProjectService {
  static isManagerRole(role?: UserRole) {
    return role === USER_ROLE.MANAGER || role === USER_ROLE.PROJECT_MANAGER || role === USER_ROLE.ADMIN;
  }

  static async assertProjectAccess(projectId: string, userId: string, role: UserRole) {
    if (this.isManagerRole(role)) {
      const project = await prisma.project.findFirst({
        where: { id: projectId, deletedAt: null },
        select: { id: true }
      });

      if (!project) {
        throw new ApiError(404, "Project not found");
      }

      return;
    }

    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        deletedAt: null,
        OR: [
          { members: { some: { userId, removedAt: null } } },
          { tasks: { some: { deletedAt: null, assignees: { some: { id: userId } } } } }
        ]
      },
      select: { id: true }
    });

    if (!project) {
      throw new ApiError(404, "Project not found");
    }
  }

  static async list(userId: string, role: UserRole, page = 1, limit = 50) {
    const isManager = this.isManagerRole(role);
    const skip = (page - 1) * limit;

    const where = isManager
      ? { deletedAt: null }
      : {
          deletedAt: null,
          OR: [
            { members: { some: { userId, removedAt: null } } },
            { tasks: { some: { deletedAt: null, assignees: { some: { id: userId } } } } }
          ]
        };

    const [total, data] = await Promise.all([
      prisma.project.count({ where }),
      prisma.project.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: limit,
        skip,
        include: {
          manager: {
            select: { id: true, fullName: true, email: true, avatarUrl: true }
          },
          members: {
            where: { removedAt: null },
            include: {
              user: {
                select: { id: true, fullName: true, email: true, avatarUrl: true, title: true }
              }
            }
          },
          _count: {
            select: { tasks: true }
          }
        }
      })
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) }
    };
  }

  static async getById(projectId: string, userId?: string, role?: UserRole) {
    const isManager = !userId || !role || this.isManagerRole(role);

    const project = await prisma.project.findFirst({
      where: { 
        id: projectId, 
        deletedAt: null,
        ...(isManager ? {} : {
          OR: [
            { members: { some: { userId, removedAt: null } } },
            { tasks: { some: { deletedAt: null, assignees: { some: { id: userId } } } } }
          ]
        })
      },
      include: {
        manager: {
          select: { id: true, fullName: true, email: true, avatarUrl: true }
        },
        members: {
          where: { removedAt: null },
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                email: true,
                avatarUrl: true,
                title: true,
                status: true
              }
            }
          }
        },
        tasks: {
          where: { 
            deletedAt: null,
            ...(isManager ? {} : { assignees: { some: { id: userId } } })
          },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }]
        }
      }
    });

    if (!project) {
      throw new ApiError(404, "Project not found");
    }

    return {
      ...project,
      teamMemberIds: project.members.map((m: any) => m.userId)
    };
  }

  static async getBundle(projectId: string, userId?: string, role?: UserRole) {
    const isManager = !userId || !role || this.isManagerRole(role);

    const project = await prisma.project.findFirst({
      where: { 
        id: projectId, 
        deletedAt: null,
        ...(isManager ? {} : {
          OR: [
            { members: { some: { userId, removedAt: null } } },
            { tasks: { some: { deletedAt: null, assignees: { some: { id: userId } } } } }
          ]
        })
      },
      include: {
        manager: {
          select: { id: true, fullName: true, email: true, avatarUrl: true, title: true, status: true }
        },
        members: {
          where: { removedAt: null },
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                email: true,
                avatarUrl: true,
                title: true,
                status: true
              }
            }
          }
        },
        tasks: {
          where: { 
            deletedAt: null,
            ...(isManager ? {} : { assignees: { some: { id: userId } } })
          },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
          include: {
            assignees: {
              select: { id: true, fullName: true, email: true, avatarUrl: true, title: true, status: true }
            },
            attachments: true
          }
        },
        attachments: true
      }
    });

    if (!project) {
      throw new ApiError(404, "Project not found");
    }

    const { tasks, members, manager, attachments, ...projectData } = project;

    const tasksWithStatus = tasks.map((task: any) => ({
      ...task,
      attachments: task.attachments || []
    }));

    const usersMap = new Map();
    usersMap.set(manager.id, manager);
    members.forEach((m: any) => usersMap.set(m.user.id, m.user));
    tasks.forEach((t: any) => {
      t.assignees.forEach((a: any) => usersMap.set(a.id, a));
    });

    return {
      project: { 
        ...projectData, 
        manager, 
        members: members.map((m: any) => ({ userId: m.userId, user: m.user })), 
        teamMemberIds: members.map((m: any) => m.userId),
        attachments: attachments || [] 
      },
      tasks: tasksWithStatus,
      users: Array.from(usersMap.values())
    };
  }

  static async create(
    userId: string,
    userRole: UserRole,
    input: {
      name: string;
      description?: string;
      status?: ProjectStatus;
      startDate?: string;
      dueDate?: string;
      managerId: string;
      memberIds?: string[];
    }
  ) {
    const slugBase = createSlug(input.name);
    const uniqueSlug = `${slugBase}-${Date.now().toString().slice(-6)}`;

    const project = await prisma.project.create({
      data: {
        id: generateShortId(),
        name: input.name,
        slug: uniqueSlug,
        description: input.description,
        status: input.status ?? PROJECT_STATUS.ACTIVE,
        startDate: input.startDate ? new Date(input.startDate) : null,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        managerId: input.managerId,
        createdById: userId,
        members: {
          create: [...new Set([input.managerId, ...(input.memberIds ?? [])])].map((memberId) => ({
            userId: memberId,
            role: memberId === input.managerId ? MEMBERSHIP_ROLE.MANAGER : MEMBERSHIP_ROLE.CONTRIBUTOR
          }))
        }
      }
    });

    await ActivityService.log({
      action: "PROJECT_CREATED",
      entityType: "project",
      entityId: project.id,
      description: `Created project ${project.name}`,
      userId,
      projectId: project.id
    });

    const allMemberIds = [...new Set([input.managerId, ...(input.memberIds ?? [])])];
    for (const memberId of allMemberIds) {
      if (memberId !== userId) {
        await NotificationService.create({
          userId: memberId,
          type: "PROJECT_UPDATED",
          title: "New Project Assignment",
          message: `You have been added to a new project: ${project.name}`,
          projectId: project.id
        });
      }
    }

    return this.getById(project.id, userId, userRole);
  }

  static async update(
    projectId: string,
    userId: string,
    userRole: UserRole,
    input: {
      name?: string;
      description?: string;
      status?: ProjectStatus;
      startDate?: string | null;
      dueDate?: string | null;
      managerId?: string;
      memberIds?: string[];
    }
  ) {
    const existingProject = await this.getById(projectId, userId, userRole);

    const project = await prisma.project.update({
      where: { id: projectId },
      data: {
        name: input.name,
        description: input.description,
        status: input.status,
        startDate: input.startDate === undefined ? undefined : input.startDate ? new Date(input.startDate) : null,
        dueDate: input.dueDate === undefined ? undefined : input.dueDate ? new Date(input.dueDate) : null,
        managerId: input.managerId,
        completedAt: input.status === PROJECT_STATUS.COMPLETED ? new Date() : undefined
      }
    });

    if (input.memberIds) {
      const existingMembers = await prisma.projectMember.findMany({
        where: { projectId, removedAt: null },
        select: { userId: true }
      });
      const existingMemberIds = existingMembers.map((m: any) => m.userId);
      
      const newMemberIds = input.memberIds.filter((id) => !existingMemberIds.includes(id));
      const removedMemberIds = existingMemberIds.filter((id) => !input.memberIds!.includes(id));

      if (newMemberIds.length > 0) {
        // Upsert memberships
        for (const memberId of newMemberIds) {
          const existingRecord = await prisma.projectMember.findUnique({
            where: { projectId_userId: { projectId, userId: memberId } }
          });
          if (existingRecord) {
            await prisma.projectMember.update({
              where: { id: existingRecord.id },
              data: { removedAt: null, role: memberId === input.managerId ? MEMBERSHIP_ROLE.MANAGER : MEMBERSHIP_ROLE.CONTRIBUTOR }
            });
          } else {
            await prisma.projectMember.create({
              data: {
                projectId,
                userId: memberId,
                role: memberId === input.managerId ? MEMBERSHIP_ROLE.MANAGER : MEMBERSHIP_ROLE.CONTRIBUTOR
              }
            });
          }

          if (memberId !== userId) {
            await NotificationService.create({
              userId: memberId,
              type: "PROJECT_UPDATED",
              title: "Project Assignment",
              message: `You have been added to project: ${project.name}`,
              projectId: project.id
            });
          }
        }
      }

      if (removedMemberIds.length > 0) {
        await prisma.projectMember.updateMany({
          where: { projectId, userId: { in: removedMemberIds }, removedAt: null },
          data: { removedAt: new Date() }
        });
      }
    }

    await ActivityService.log({
      action: "PROJECT_UPDATED",
      entityType: "project",
      entityId: project.id,
      description: `Updated project ${project.name}`,
      userId,
      projectId: project.id
    });

    const updatedProject = await this.getById(project.id, userId, userRole);
    
    // Notify newly added members individually so they get the update even if not in the project room
    if (input.memberIds) {
      const existingMembers = await prisma.projectMember.findMany({
        where: { projectId, removedAt: null },
        select: { userId: true }
      });
      const currentMemberIds = existingMembers.map((m: any) => m.userId);
      // We can just emit to all current members or just the ones that were just added.
      // Since we already emitToAll, it's mostly for immediate focus.
    }

    socketService.emitToProject(project.id, "project_updated", updatedProject);
    socketService.emitToAll("project_updated", updatedProject); // Ensure global list updates
    return updatedProject;
  }

  static async archive(projectId: string, userId: string, userRole: UserRole) {
    const project = await this.getById(projectId, userId, userRole);

    await prisma.$transaction([
      prisma.project.update({
        where: { id: projectId },
        data: { deletedAt: new Date() }
      }),
      prisma.projectMember.updateMany({
        where: { projectId, removedAt: null },
        data: { removedAt: new Date() }
      }),
      prisma.task.updateMany({
        where: { projectId, deletedAt: null },
        data: { deletedAt: new Date() }
      })
    ]);

    await ActivityService.log({
      action: "PROJECT_ARCHIVED",
      entityType: "project",
      entityId: project.id,
      description: `Archived project ${project.name}`,
      userId,
      projectId: project.id
    });

    socketService.emitToProject(project.id, "project_deleted", { projectId: project.id });

    return { success: true };
  }

  static async assignMembers(
    projectId: string,
    actorUserId: string,
    userRole: UserRole,
    input: { memberIds: string[]; role?: MembershipRole }
  ) {
    await this.getById(projectId, actorUserId, userRole);

    const existingMembers = await prisma.projectMember.findMany({
      where: { projectId },
      select: { userId: true }
    });

    const existingUserIds = new Set(existingMembers.map((member) => member.userId));
    const newMemberIds = input.memberIds.filter((memberId) => !existingUserIds.has(memberId));

    if (newMemberIds.length > 0) {
      await prisma.projectMember.createMany({
        data: newMemberIds.map((memberId) => ({
          projectId,
          userId: memberId,
          role: input.role ?? MEMBERSHIP_ROLE.CONTRIBUTOR
        }))
      });

      // Send notifications to new members
      for (const memberId of newMemberIds) {
        if (memberId !== actorUserId) {
          const project = await prisma.project.findUnique({ where: { id: projectId } });
          await NotificationService.create({
            userId: memberId,
            type: "PROJECT_UPDATED",
            title: "Project Assignment",
            message: `You have been added to project: ${project?.name || 'Unknown'}`,
            projectId: projectId
          }).catch(err => console.error("Notification failed for project assign:", err));
        }
      }
    }

    await ActivityService.log({
      action: "PROJECT_MEMBER_ADDED",
      entityType: "project",
      entityId: projectId,
      description: `Added ${newMemberIds.length} member(s) to project`,
      userId: actorUserId,
      projectId,
      metadata: { memberIds: newMemberIds }
    });

    return this.getById(projectId, actorUserId, userRole);
  }

  static async removeMember(projectId: string, memberId: string, actorUserId: string, userRole: UserRole) {
    const membership = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: memberId } }
    });

    if (!membership || membership.removedAt) {
      throw new ApiError(404, "Project member not found");
    }

    await prisma.projectMember.update({
      where: { projectId_userId: { projectId, userId: memberId } },
      data: { removedAt: new Date() }
    });

    await ActivityService.log({
      action: "PROJECT_MEMBER_REMOVED",
      entityType: "project",
      entityId: projectId,
      description: "Removed project member",
      userId: actorUserId,
      projectId,
      metadata: { memberId }
    });

    return { success: true };
  }
}
