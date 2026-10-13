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

export type ProjectRole = "viewer" | "contributor" | "manager";
const ROLE_RANK: Record<ProjectRole, number> = { viewer: 0, contributor: 1, manager: 2 };

export class ProjectService {
  static isManagerRole(role?: UserRole) {
    return role === USER_ROLE.MANAGER || role === USER_ROLE.PROJECT_MANAGER || role === USER_ROLE.ADMIN;
  }

  // Unknown or removed users would otherwise surface as a raw foreign-key 500. Suspended people can't be
  // newly added, but those `alreadyLinked` stay, so re-saving a form that still lists them keeps working.
  static async assertActiveUsers(userIds: string[], alreadyLinked: string[] = []) {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return;
    const found = await prisma.user.findMany({
      where: { id: { in: unique }, deletedAt: null, pendingApproval: false },
      select: { id: true, fullName: true, status: true }
    });
    if (found.length !== unique.length) {
      throw new ApiError(400, "One or more selected people are not active team members");
    }
    const suspended = found.filter((u) => u.status === "SUSPENDED" && !alreadyLinked.includes(u.id));
    if (suspended.length) {
      throw new ApiError(400, `${suspended.map((u) => u.fullName).join(", ")} is suspended and can't be added`);
    }
  }

  // Live project updates go to the project's room and to each member, never to every connected user
  static async broadcastProjectUpdate(projectId: string, payload: unknown, extraUserIds: string[] = []) {
    const members = await prisma.projectMember.findMany({
      where: { projectId, removedAt: null },
      select: { userId: true }
    });
    socketService.emitToProject(projectId, "project_updated", payload);
    for (const userId of new Set([...members.map((m) => m.userId), ...extraUserIds])) {
      socketService.emitToUser(userId, "project_updated", payload);
    }
  }

  // What this person may do in one project: company-wide managers manage everything; otherwise the
  // membership role decides (OWNER/MANAGER manage, VIEWER only reads). Task assignees who aren't
  // members keep contributor access, as before. null = no access (deleted or unseen project).
  static async projectRole(projectId: string, userId: string, globalRole: UserRole): Promise<ProjectRole | null> {
    const project = await prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: {
        members: { where: { userId, removedAt: null }, select: { role: true } },
        tasks: { where: { deletedAt: null, assignees: { some: { id: userId } } }, select: { id: true }, take: 1 }
      }
    });
    if (!project) return null;
    if (this.isManagerRole(globalRole)) return "manager";
    const membership = project.members[0]?.role;
    if (membership === MEMBERSHIP_ROLE.OWNER || membership === MEMBERSHIP_ROLE.MANAGER) return "manager";
    if (membership === MEMBERSHIP_ROLE.VIEWER) return "viewer";
    if (membership || project.tasks.length) return "contributor";
    return null;
  }

  static async requireProjectRole(projectId: string, userId: string, globalRole: UserRole, needed: ProjectRole) {
    const role = await this.projectRole(projectId, userId, globalRole);
    if (!role) throw new ApiError(404, "Project not found");
    if (ROLE_RANK[role] < ROLE_RANK[needed]) {
      throw new ApiError(403, needed === "manager" ? "Only this project's managers can do that" : "You have view-only access to this project");
    }
    return role;
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

  // shortcut: the UI has no paging and reads one page, so the page is large; add paging to the UI past ~1000 projects
  static async list(userId: string, role: UserRole, page = 1, limit = 1000) {
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

  static async getBundle(projectId: string, userId: string, role: UserRole) {
    const myRole = await this.projectRole(projectId, userId, role);
    if (!myRole) {
      throw new ApiError(404, "Project not found");
    }
    // Members see the whole board; someone who is only assigned a task sees just their own work
    const isMember = this.isManagerRole(role) || !!(await prisma.projectMember.findFirst({
      where: { projectId, userId, removedAt: null },
      select: { id: true }
    }));

    const project = await prisma.project.findFirstOrThrow({
      where: { id: projectId, deletedAt: null },
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
            ...(isMember ? {} : { assignees: { some: { id: userId } } })
          },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
          include: {
            assignees: {
              select: { id: true, fullName: true, email: true, avatarUrl: true, title: true, status: true }
            },
            attachments: true,
            subtasks: { select: { done: true } },
            blockedBy: { where: { deletedAt: null }, select: { id: true, title: true, status: true } }
          }
        },
        attachments: true,
        milestones: {
          orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
          include: { tasks: { where: { deletedAt: null }, select: { status: true } } }
        }
      }
    });

    const { tasks, members, manager, attachments, milestones, ...projectData } = project;

    const tasksWithStatus = tasks.map(({ subtasks, ...task }: any) => ({
      ...task,
      attachments: task.attachments || [],
      subtaskTotal: subtasks.length,
      subtaskDone: subtasks.filter((s: any) => s.done).length
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
        members: members.map((m: any) => ({ userId: m.userId, role: m.role, user: m.user })),
        teamMemberIds: members.map((m: any) => m.userId),
        attachments: attachments || [],
        myRole,
        milestones: milestones.map(({ tasks: mTasks, ...m }) => ({
          ...m,
          taskTotal: mTasks.length,
          taskDone: mTasks.filter((t) => t.status === "DONE").length
        }))
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
      copyFromProjectId?: string;
    }
  ) {
    await this.assertActiveUsers([input.managerId, ...(input.memberIds ?? [])]);
    if (input.copyFromProjectId) {
      await this.requireProjectRole(input.copyFromProjectId, userId, userRole, "viewer");
    }

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

    if (input.copyFromProjectId) {
      await this.copyPlan(input.copyFromProjectId, project.id, project.startDate, input.managerId, userId);
    }

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
    await this.requireProjectRole(projectId, userId, userRole, "manager");
    const existingProject = await this.getById(projectId, userId, userRole);
    const managerId = input.managerId ?? existingProject.managerId;
    // The project manager always stays on the team, even if the form left them out
    const memberIds = input.memberIds ? [...new Set([managerId, ...input.memberIds])] : undefined;
    await this.assertActiveUsers(
      [...(input.managerId ? [input.managerId] : []), ...(memberIds ?? [])],
      [existingProject.managerId, ...existingProject.teamMemberIds]
    );

    const startDate = input.startDate === undefined ? existingProject.startDate : input.startDate ? new Date(input.startDate) : null;
    const dueDate = input.dueDate === undefined ? existingProject.dueDate : input.dueDate ? new Date(input.dueDate) : null;
    if (startDate && dueDate && startDate > dueDate) {
      throw new ApiError(400, "Start date must be on or before the end date");
    }

    const statusChanged = input.status !== undefined && input.status !== existingProject.status;

    const project = await prisma.project.update({
      where: { id: projectId },
      data: {
        name: input.name,
        description: input.description,
        status: input.status,
        startDate: input.startDate === undefined ? undefined : startDate,
        dueDate: input.dueDate === undefined ? undefined : dueDate,
        managerId: input.managerId,
        // Stamp completion only when the status actually changes, so re-saving doesn't move the date
        completedAt: !statusChanged ? undefined : input.status === PROJECT_STATUS.COMPLETED ? new Date() : null
      }
    });

    if (memberIds) {
      input.memberIds = memberIds;
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
              data: { removedAt: null, role: memberId === managerId ? MEMBERSHIP_ROLE.MANAGER : MEMBERSHIP_ROLE.CONTRIBUTOR }
            });
          } else {
            await prisma.projectMember.create({
              data: {
                projectId,
                userId: memberId,
                role: memberId === managerId ? MEMBERSHIP_ROLE.MANAGER : MEMBERSHIP_ROLE.CONTRIBUTOR
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

    // Removed members also hear about it, so their lists drop the project; task lists stay out of the broadcast
    const { tasks: _tasks, ...projectPayload } = updatedProject;
    const removedIds = existingProject.teamMemberIds.filter((id) => !updatedProject.teamMemberIds.includes(id));
    await this.broadcastProjectUpdate(project.id, projectPayload, removedIds);
    return updatedProject;
  }

  static async archive(projectId: string, userId: string, userRole: UserRole) {
    await this.requireProjectRole(projectId, userId, userRole, "manager");
    const project = await this.getById(projectId, userId, userRole);

    // One timestamp for all three, so "Restore" can tell what was removed together with the project
    const now = new Date();
    await prisma.$transaction([
      prisma.project.update({
        where: { id: projectId },
        data: { deletedAt: now }
      }),
      prisma.projectMember.updateMany({
        where: { projectId, removedAt: null },
        data: { removedAt: now }
      }),
      prisma.task.updateMany({
        where: { projectId, deletedAt: null },
        data: { deletedAt: now }
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
    for (const memberId of project.teamMemberIds) {
      socketService.emitToUser(memberId, "project_deleted", { projectId: project.id });
    }

    return { success: true };
  }

  static async assignMembers(
    projectId: string,
    actorUserId: string,
    userRole: UserRole,
    input: { memberIds: string[]; role?: MembershipRole }
  ) {
    await this.requireProjectRole(projectId, actorUserId, userRole, "manager");
    const current = await this.getById(projectId, actorUserId, userRole);
    await this.assertActiveUsers(input.memberIds, current.teamMemberIds);

    const activeMembers = await prisma.projectMember.findMany({
      where: { projectId, removedAt: null },
      select: { userId: true }
    });

    const activeUserIds = new Set(activeMembers.map((member) => member.userId));
    const newMemberIds = [...new Set(input.memberIds)].filter((memberId) => !activeUserIds.has(memberId));

    if (newMemberIds.length > 0) {
      // Upsert so someone removed earlier can be added back (their old row still exists)
      for (const memberId of newMemberIds) {
        await prisma.projectMember.upsert({
          where: { projectId_userId: { projectId, userId: memberId } },
          update: { removedAt: null, role: input.role ?? MEMBERSHIP_ROLE.CONTRIBUTOR },
          create: { projectId, userId: memberId, role: input.role ?? MEMBERSHIP_ROLE.CONTRIBUTOR }
        });
      }

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
    await this.requireProjectRole(projectId, actorUserId, userRole, "manager");
    const membership = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: memberId } }
    });

    if (!membership || membership.removedAt) {
      throw new ApiError(404, "Project member not found");
    }

    const project = await this.getById(projectId, actorUserId, userRole);
    if (project.managerId === memberId) {
      throw new ApiError(400, "The project manager cannot be removed from the team; assign a new manager first");
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

    const { tasks: _tasks, ...projectPayload } = await this.getById(projectId, actorUserId, userRole);
    await this.broadcastProjectUpdate(projectId, projectPayload, [memberId]);

    return { success: true };
  }

  // "Start from an existing project": copy its milestones and open plan (tasks, subtasks, labels, estimates),
  // shifting dates by the gap between the two start dates. Copies start as To Do, assigned to the new manager.
  static async copyPlan(sourceId: string, targetId: string, targetStart: Date | null, assigneeId: string, actorUserId: string) {
    const source = await prisma.project.findUniqueOrThrow({
      where: { id: sourceId },
      include: {
        milestones: true,
        tasks: { where: { deletedAt: null }, include: { subtasks: { orderBy: { sortOrder: "asc" } } }, orderBy: { sortOrder: "asc" } }
      }
    });
    const shiftMs = (targetStart ?? new Date()).getTime() - (source.startDate ?? source.createdAt).getTime();
    const shift = (d: Date | null) => (d ? new Date(d.getTime() + shiftMs) : null);

    const milestoneIds = new Map<string, string>();
    for (const m of source.milestones) {
      const created = await prisma.milestone.create({ data: { projectId: targetId, name: m.name, dueDate: shift(m.dueDate) } });
      milestoneIds.set(m.id, created.id);
    }
    for (const t of source.tasks) {
      await prisma.task.create({
        data: {
          id: generateShortId(),
          projectId: targetId,
          title: t.title,
          description: t.description,
          priority: t.priority,
          status: "TODO",
          dueDate: shift(t.dueDate),
          startDate: shift(t.startDate),
          labels: t.labels,
          estimateHours: t.estimateHours,
          recurrence: t.recurrence,
          sortOrder: t.sortOrder,
          milestoneId: t.milestoneId ? milestoneIds.get(t.milestoneId) ?? null : null,
          createdById: actorUserId,
          assignees: { connect: [{ id: assigneeId }] },
          subtasks: { create: t.subtasks.map((s) => ({ title: s.title, sortOrder: s.sortOrder })) }
        }
      });
    }
  }

  // Per-project role (Owner/Manager/Contributor/Viewer) for one member
  static async setMemberRole(projectId: string, memberId: string, role: MembershipRole, actorUserId: string, userRole: UserRole) {
    await this.requireProjectRole(projectId, actorUserId, userRole, "manager");
    const project = await prisma.project.findFirstOrThrow({ where: { id: projectId }, select: { managerId: true, name: true } });
    if (memberId === actorUserId) {
      throw new ApiError(400, "You cannot change your own project role");
    }
    if (memberId === project.managerId && role !== MEMBERSHIP_ROLE.MANAGER && role !== MEMBERSHIP_ROLE.OWNER) {
      throw new ApiError(400, "The project manager must keep a manager role; assign a new manager first");
    }
    const updated = await prisma.projectMember.updateMany({
      where: { projectId, userId: memberId, removedAt: null },
      data: { role }
    });
    if (updated.count === 0) throw new ApiError(404, "Project member not found");

    await ActivityService.log({
      action: "PROJECT_UPDATED",
      entityType: "project",
      entityId: projectId,
      description: `Changed a member's project role to ${role.toLowerCase()}`,
      userId: actorUserId,
      projectId,
      metadata: { memberId, role }
    });
    const { tasks: _tasks, ...projectPayload } = await this.getById(projectId, actorUserId, userRole);
    await this.broadcastProjectUpdate(projectId, projectPayload);
    return { success: true };
  }

  // Create (milestoneId null) or update a milestone; project managers only
  static async saveMilestone(
    projectId: string,
    milestoneId: string | null,
    input: { name?: string; dueDate?: string | null },
    actorUserId: string,
    userRole: UserRole
  ) {
    await this.requireProjectRole(projectId, actorUserId, userRole, "manager");
    const data = {
      name: input.name,
      dueDate: input.dueDate === undefined ? undefined : input.dueDate ? new Date(input.dueDate) : null
    };
    const milestone = milestoneId
      ? await prisma.milestone.update({ where: { id: milestoneId, projectId }, data })
      : await prisma.milestone.create({ data: { projectId, name: input.name!, dueDate: data.dueDate ?? null } });
    socketService.emitToProject(projectId, "project_updated", { id: projectId });
    return milestone;
  }

  static async deleteMilestone(projectId: string, milestoneId: string, actorUserId: string, userRole: UserRole) {
    await this.requireProjectRole(projectId, actorUserId, userRole, "manager");
    // Tasks keep existing; their milestone link clears (onDelete: SetNull)
    await prisma.milestone.delete({ where: { id: milestoneId, projectId } });
    socketService.emitToProject(projectId, "project_updated", { id: projectId });
  }

  // Recently deleted: projects and tasks soft-deleted in the last 30 days (company-wide managers only)
  static async listTrash() {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [projects, tasks] = await Promise.all([
      prisma.project.findMany({
        where: { deletedAt: { gte: since } },
        orderBy: { deletedAt: "desc" },
        select: { id: true, name: true, deletedAt: true, _count: { select: { tasks: true } } }
      }),
      prisma.task.findMany({
        // Tasks of a deleted project come back with it, so list only tasks deleted on their own
        where: { deletedAt: { gte: since }, project: { deletedAt: null } },
        orderBy: { deletedAt: "desc" },
        select: { id: true, title: true, deletedAt: true, project: { select: { id: true, name: true } } }
      })
    ]);
    return { projects, tasks };
  }

  static async restore(projectId: string, actorUserId: string) {
    const project = await prisma.project.findFirst({ where: { id: projectId, deletedAt: { not: null } } });
    if (!project || !project.deletedAt) throw new ApiError(404, "Deleted project not found");

    // archive() stamps the project, its tasks and its memberships with one timestamp; bring those back,
    // but not tasks or members removed on their own earlier. The 1 s margin covers projects deleted by
    // the older code, which stamped each part separately (milliseconds apart).
    const from = new Date(project.deletedAt.getTime() - 1000);
    const to = new Date(project.deletedAt.getTime() + 1000);
    await prisma.$transaction([
      prisma.project.update({ where: { id: projectId }, data: { deletedAt: null } }),
      prisma.task.updateMany({ where: { projectId, deletedAt: { gte: from, lte: to } }, data: { deletedAt: null } }),
      prisma.projectMember.updateMany({ where: { projectId, removedAt: { gte: from, lte: to } }, data: { removedAt: null } })
    ]);
    await ActivityService.log({
      action: "PROJECT_UPDATED",
      entityType: "project",
      entityId: projectId,
      description: `Restored project ${project.name}`,
      userId: actorUserId,
      projectId
    });
    return { success: true };
  }
}
