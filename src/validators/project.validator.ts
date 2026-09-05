import { z } from "zod";
import { MEMBERSHIP_ROLE, PROJECT_STATUS } from "../constants/enums.js";

export const createProjectSchema = z.object({
  name: z.string().min(2).max(140),
  description: z.string().min(1).max(4000),
  status: z.nativeEnum(PROJECT_STATUS),
  startDate: z.string().datetime(),
  dueDate: z.string().datetime(),
  managerId: z.string(),
  memberIds: z.array(z.string()).min(1, "At least one project team member is required")
});

export const updateProjectSchema = z.object({
  name: z.string().min(2).max(140).optional(),
  description: z.string().max(4000).optional(),
  status: z.nativeEnum(PROJECT_STATUS).optional(),
  startDate: z.string().datetime().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  managerId: z.string().optional(),
  memberIds: z.array(z.string()).optional()
});

export const assignMembersSchema = z.object({
  memberIds: z.array(z.string()).min(1),
  role: z.nativeEnum(MEMBERSHIP_ROLE).optional()
});
