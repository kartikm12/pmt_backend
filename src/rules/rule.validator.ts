import { z } from "zod";

// When ...
export const TRIGGERS = ["TASK_CREATED", "MOVED_TO_COLUMN", "ASSIGNED", "DUE_TOMORROW", "OVERDUE"] as const;
// Then ...
export const ACTIONS = ["ASSIGN", "ADD_WATCHER", "MOVE_TO_COLUMN", "SET_PRIORITY", "ADD_LABEL", "NOTIFY"] as const;
export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
// NOTIFY can name a person, or one of these groups
export const NOTIFY_GROUPS = ["PROJECT_MANAGERS", "ASSIGNEES"] as const;
export const MAX_RULES_PER_PROJECT = 50;

const id = z.string().trim().min(1).max(64);

export const ruleSchema = z.object({
  enabled: z.boolean().default(true),
  trigger: z.enum(TRIGGERS),
  // MOVED_TO_COLUMN: the column id; ASSIGNED: a person's id (empty = anyone); OVERDUE: days (1-60)
  triggerValue: z.string().trim().max(64).nullable().optional(),
  conditions: z.object({
    priorities: z.array(z.enum(PRIORITIES)).max(4).optional(),
    label: z.string().trim().min(1).max(30).optional(),
    assigneeId: id.optional()
  }).default({}),
  actions: z.array(z.object({
    type: z.enum(ACTIONS),
    value: z.string().trim().min(1).max(64)
  })).min(1, "Add at least one action").max(5, "A rule can do at most 5 things")
}).superRefine((r, ctx) => {
  if (r.trigger === "MOVED_TO_COLUMN" && !r.triggerValue) ctx.addIssue({ code: "custom", path: ["triggerValue"], message: "Pick the column" });
  if (r.trigger === "OVERDUE") {
    const n = Number(r.triggerValue);
    if (!Number.isInteger(n) || n < 1 || n > 60) ctx.addIssue({ code: "custom", path: ["triggerValue"], message: "Overdue days must be a whole number from 1 to 60" });
  }
  for (const a of r.actions) {
    if (a.type === "SET_PRIORITY" && !(PRIORITIES as readonly string[]).includes(a.value)) ctx.addIssue({ code: "custom", path: ["actions"], message: "Pick a priority" });
    if (a.type === "ADD_LABEL" && a.value.length > 30) ctx.addIssue({ code: "custom", path: ["actions"], message: "Labels are up to 30 characters" });
  }
});

export const ruleToggleSchema = z.object({ enabled: z.boolean() });

export const columnsSchema = z.object({
  columns: z.array(z.object({
    id: z.string().min(1).max(80).optional(),
    name: z.string().trim().min(1, "Each column needs a name").max(30, "Column names are up to 30 characters"),
    stage: z.enum(["TODO", "IN_PROGRESS", "REVIEW", "DONE"])
  })).min(1).max(12),
  // removed column id -> existing column id or "new:<index in columns>"
  moveTo: z.record(z.string().max(80)).default({})
});

export type RuleInput = z.infer<typeof ruleSchema>;
