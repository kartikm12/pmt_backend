import { z } from "zod";
import { MEMBERSHIP_ROLE, PROJECT_STATUS } from "../constants/enums.js";

export const createProjectSchema = z.object({
  name: z.string().trim().min(2).max(140),
  description: z.string().trim().min(1).max(4000),
  status: z.nativeEnum(PROJECT_STATUS),
  startDate: z.string().datetime(),
  dueDate: z.string().datetime(),
  managerId: z.string().min(1),
  memberIds: z.array(z.string()).min(1, "At least one project team member is required"),
  copyFromProjectId: z.string().min(1).optional()
}).refine((p) => p.startDate <= p.dueDate, {
  message: "Start date must be on or before the end date",
  path: ["startDate"]
});

export const updateProjectSchema = z.object({
  name: z.string().trim().min(2).max(140).optional(),
  description: z.string().trim().min(1).max(4000).optional(),
  status: z.nativeEnum(PROJECT_STATUS).optional(),
  startDate: z.string().datetime().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  managerId: z.string().optional(),
  memberIds: z.array(z.string()).optional(),
  closeOpenTasks: z.boolean().optional()
});

export const memberRoleSchema = z.object({
  role: z.nativeEnum(MEMBERSHIP_ROLE)
});

export const assignMembersSchema = z.object({
  memberIds: z.array(z.string()).min(1),
  role: z.nativeEnum(MEMBERSHIP_ROLE).optional()
});
