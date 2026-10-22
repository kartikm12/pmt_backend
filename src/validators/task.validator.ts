import { z } from "zod";
import { normalizeRule } from "../utils/repeatRule.js";
import { TASK_PRIORITY, TASK_STATUS } from "../constants/enums.js";

// Shared by create and update: the 14 Oct planning fields
const planningFields = {
  startDate: z.string().datetime().nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  estimateHours: z.number().min(0).max(1000).nullable().optional(),
  // A repeat rule (utils/repeatRule.ts) or the old DAILY / WEEKLY / MONTHLY
  recurrence: z.string().max(200).refine((v) => normalizeRule(v, null) !== null, "That repeat setting isn't valid").nullable().optional(),
  blockedByIds: z.array(z.string().min(1)).max(50).optional()
};

export const reorderSchema = z.object({
  projectId: z.string().min(1),
  status: z.nativeEnum(TASK_STATUS),
  orderedIds: z.array(z.string().min(1)).min(1).max(1000)
});

export const subtaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  done: z.boolean().optional()
});

export const timeEntrySchema = z.object({
  minutes: z.number().int().min(1, "Log at least one minute").max(24 * 60, "One entry can't be longer than a day"),
  note: z.string().trim().max(500).optional(),
  spentOn: z.string().datetime().optional()
});

export const createTaskSchema = z.object({
  ...planningFields,
  title: z.string().trim().min(2).max(180),
  description: z.string().trim().min(1).max(4000),
  priority: z.nativeEnum(TASK_PRIORITY),
  status: z.nativeEnum(TASK_STATUS),
  dueDate: z.string().datetime(),
  projectId: z.string().min(1),
  assigneeIds: z.array(z.string().min(1)).min(1, "At least one assignee is required"),
  sortOrder: z.number().int().min(0).optional()
});

export const updateTaskSchema = z.object({
  ...planningFields,
  title: z.string().trim().min(2).max(180).optional(),
  description: z.string().trim().min(1).max(4000).optional(),
  priority: z.nativeEnum(TASK_PRIORITY).optional(),
  status: z.nativeEnum(TASK_STATUS).optional(),
  dueDate: z.string().datetime().nullable().optional(),
  // The edit form has a Project picker; without this field zod silently dropped the move
  projectId: z.string().min(1).optional(),
  assigneeIds: z.array(z.string().min(1)).min(1, "At least one assignee is required").optional(),
  sortOrder: z.number().int().min(0).optional()
});

export const createCommentSchema = z.object({
  body: z.string().trim().min(1, "Comment cannot be empty").max(5000)
});
