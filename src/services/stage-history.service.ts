import { prisma } from "../prisma/client.js";
import { ProjectService } from "./project.service.js";
import type { UserRole } from "../constants/enums.js";

// How long each task spent in each stage (To Do, In progress, Review, Completed), in order, including going
// back (Review -> In progress -> Review). Built from what PMT already records: the task's creation and each
// "Moved task to ..." entry (TASK_STATUS_CHANGED, which carries the new stage). Creation records its stage
// since 24 Nov 2026; for tasks made before that, the first stage is taken to be To Do.

export type StageSegment = { stage: string; from: string; to: string | null };
export type TaskStages = { id: string; title: string; status: string; createdAt: string; segments: StageSegment[] };

type LogRow = { taskId: string | null; action: string; metadata: unknown; createdAt: Date };

const stageOf = (metadata: unknown): string | null => {
  const s = (metadata as { status?: unknown } | null)?.status;
  return typeof s === "string" && ["TODO", "IN_PROGRESS", "REVIEW", "DONE"].includes(s) ? s : null;
};

export function buildSegments(task: { createdAt: Date; status: string }, logs: LogRow[]): StageSegment[] {
  const ordered = [...logs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const created = ordered.find((l) => l.action === "TASK_CREATED");
  const changes = ordered.filter((l) => l.action === "TASK_STATUS_CHANGED" && stageOf(l.metadata));
  // First stage: what creation recorded; else, for older tasks with no changes, the stage it is in now
  let stage = stageOf(created?.metadata) ?? (changes.length ? "TODO" : task.status);
  let from = task.createdAt;
  const segments: StageSegment[] = [];
  for (const c of changes) {
    const next = stageOf(c.metadata)!;
    if (next === stage) continue; // a repeated save in the same stage
    if (c.createdAt.getTime() > from.getTime()) segments.push({ stage, from: from.toISOString(), to: c.createdAt.toISOString() });
    stage = next;
    from = c.createdAt;
  }
  // The stage it is in now (a finished task ends where it was completed)
  segments.push({ stage, from: from.toISOString(), to: stage === "DONE" ? from.toISOString() : null });
  return segments;
}

export class StageHistoryService {
  static async forProject(projectId: string, userId: string, role: UserRole): Promise<TaskStages[]> {
    await ProjectService.requireProjectRole(projectId, userId, role, "viewer", { closedOk: true });
    const tasks = await prisma.task.findMany({
      where: { projectId, deletedAt: null },
      select: { id: true, title: true, status: true, createdAt: true },
      orderBy: { createdAt: "asc" }
    });
    if (!tasks.length) return [];
    const logs = await prisma.activityLog.findMany({
      where: { taskId: { in: tasks.map((t) => t.id) }, action: { in: ["TASK_CREATED", "TASK_STATUS_CHANGED"] } },
      select: { taskId: true, action: true, metadata: true, createdAt: true },
      orderBy: { createdAt: "asc" }
    });
    const byTask = new Map<string, LogRow[]>();
    for (const l of logs) {
      if (!l.taskId) continue;
      const list = byTask.get(l.taskId) ?? [];
      list.push(l);
      byTask.set(l.taskId, list);
    }
    return tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      segments: buildSegments(t, byTask.get(t.id) ?? [])
    }));
  }
}
