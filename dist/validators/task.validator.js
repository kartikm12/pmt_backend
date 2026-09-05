import { z } from "zod";
import { TASK_PRIORITY, TASK_STATUS } from "../constants/enums.js";
export const createTaskSchema = z.object({
    title: z.string().min(2).max(180),
    description: z.string().min(1).max(4000),
    priority: z.nativeEnum(TASK_PRIORITY),
    status: z.nativeEnum(TASK_STATUS),
    dueDate: z.string().datetime(),
    projectId: z.string().min(1),
    assigneeIds: z.array(z.string().min(1)).min(1, "At least one assignee is required"),
    sortOrder: z.number().int().min(0).optional()
});
export const updateTaskSchema = z.object({
    title: z.string().min(2).max(180).optional(),
    description: z.string().max(4000).optional(),
    priority: z.nativeEnum(TASK_PRIORITY).optional(),
    status: z.nativeEnum(TASK_STATUS).optional(),
    dueDate: z.string().datetime().nullable().optional(),
    assigneeIds: z.array(z.string().min(1)).optional(),
    sortOrder: z.number().int().min(0).optional()
});
