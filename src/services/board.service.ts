import { Prisma } from "@prisma/client";
import { prisma } from "../prisma/client.js";
import { ApiError } from "../utils/apiError.js";
import { TASK_STATUS } from "../constants/enums.js";

export type Stage = "TODO" | "IN_PROGRESS" | "REVIEW" | "DONE";
export type Column = { id: string; projectId: string; name: string; stage: Stage; position: number };
type Db = Prisma.TransactionClient | typeof prisma;

export const STAGES: Stage[] = ["TODO", "IN_PROGRESS", "REVIEW", "DONE"];
const DEFAULTS: { stage: Stage; name: string }[] = [
  { stage: "TODO", name: "To Do" },
  { stage: "IN_PROGRESS", name: "In Progress" },
  { stage: "REVIEW", name: "Review" },
  { stage: "DONE", name: "Completed" }
];
export const MAX_COLUMNS = 12;
// Same ids as the migration's backfill, so creating the defaults twice (two requests at once) is harmless
const defaultId = (projectId: string, stage: Stage) => `col_${projectId}_${stage}`;

// What a status change does to the task's timestamps (same rules as TaskService.update)
export function stageStamps(from: Stage, to: Stage, startedAt: Date | null) {
  if (from === to) return {};
  return {
    completedAt: to === TASK_STATUS.DONE ? new Date() : null,
    ...(to === TASK_STATUS.IN_PROGRESS && !startedAt ? { startedAt: new Date() } : {})
  };
}

export class BoardService {
  // A project's columns in board order. Projects made before columns existed (or by an older server
  // during a deploy) get the four usual ones the first time anyone asks.
  static async columnsOf(projectId: string, db: Db = prisma): Promise<Column[]> {
    const found = await db.boardColumn.findMany({ where: { projectId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
    if (found.length) return found as Column[];
    await db.boardColumn.createMany({
      data: DEFAULTS.map((d, i) => ({ id: defaultId(projectId, d.stage), projectId, name: d.name, stage: d.stage, position: i })),
      skipDuplicates: true
    });
    return (await db.boardColumn.findMany({ where: { projectId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] })) as Column[];
  }

  static createDefaults(projectId: string, db: Db = prisma) {
    return this.columnsOf(projectId, db);
  }

  // The column for a stage when only a stage is known: the first column of that stage, else the nearest
  // stage that has one (a board may have no Review column; Not started and Done always exist)
  static columnForStage(columns: Column[], stage: Stage): Column {
    const at = STAGES.indexOf(stage);
    const order = [at, at - 1, at + 1, at - 2, at + 2, at - 3, at + 3].filter((i) => i >= 0 && i < STAGES.length);
    for (const i of order) {
      const c = columns.find((col) => col.stage === STAGES[i]);
      if (c) return c;
    }
    return columns[0];
  }

  // Where a task sits on the board: its column, or (saved without one) the first column of its status
  static effectiveColumn(columns: Column[], task: { columnId: string | null; status: string }): Column {
    return (task.columnId && columns.find((c) => c.id === task.columnId)) || this.columnForStage(columns, task.status as Stage);
  }

  // Turns what a request asked for (a column, a status, or neither) into the column and status to save.
  // A column wins and sets the status to its stage; a status alone keeps the current column when it is
  // already in that stage (so re-saving a form doesn't jump the card), else takes that stage's first column.
  static async placement(projectId: string, wanted: { columnId?: string | null; status?: Stage }, current?: { columnId: string | null; status: string }, db: Db = prisma) {
    if (!wanted.columnId && !wanted.status) return null;
    const columns = await this.columnsOf(projectId, db);
    if (wanted.columnId) {
      const col = columns.find((c) => c.id === wanted.columnId);
      if (!col) throw new ApiError(400, "That column isn't on this project's board any more. Refresh and try again.");
      return { columnId: col.id, status: col.stage };
    }
    if (current) {
      const here = this.effectiveColumn(columns, current);
      if (here.stage === wanted.status) return { columnId: here.id, status: here.stage };
    }
    const col = this.columnForStage(columns, wanted.status!);
    return { columnId: col.id, status: col.stage };
  }

  // Replace a project's columns with the list from the "Board columns" editor.
  // items: in board order; an item with an id is an existing column (renamed / moved / re-staged).
  // moveTo: for each removed column that still has tasks, where they go: an existing column id or "new:<index>".
  static async saveColumns(projectId: string, items: { id?: string; name: string; stage: Stage }[], moveTo: Record<string, string> = {}) {
    if (items.length < 1 || items.length > MAX_COLUMNS) throw new ApiError(400, `A board has 1 to ${MAX_COLUMNS} columns.`);
    const names = items.map((i) => i.name.trim());
    if (names.some((n) => !n || n.length > 30)) throw new ApiError(400, "Each column needs a name of up to 30 characters.");
    const lower = names.map((n) => n.toLowerCase());
    const dup = lower.find((n, i) => lower.indexOf(n) !== i);
    if (dup) throw new ApiError(400, `Two columns are called "${names[lower.indexOf(dup)]}". Give each column its own name.`);
    if (!items.some((i) => i.stage === "TODO")) throw new ApiError(400, "Keep at least one column that counts as Not started, so new tasks have somewhere to go.");
    if (!items.some((i) => i.stage === "DONE")) throw new ApiError(400, "Keep at least one column that counts as Done, so tasks can be finished.");

    return prisma.$transaction(async (tx) => {
      const before = await this.columnsOf(projectId, tx);
      const beforeIds = new Set(before.map((c) => c.id));
      const unknown = items.find((i) => i.id && !beforeIds.has(i.id));
      if (unknown) throw new ApiError(409, "Someone else changed this board's columns. Close the editor and open it again.");
      const keptIds = new Set(items.filter((i) => i.id).map((i) => i.id!));
      if (new Set(items.filter((i) => i.id).map((i) => i.id)).size !== keptIds.size) throw new ApiError(400, "The same column is listed twice.");

      // Tasks saved without a column are placed in their status's column first, so moves below catch them
      const loose = await tx.task.findMany({ where: { projectId, columnId: null }, select: { id: true, status: true } });
      for (const stage of STAGES) {
        const ids = loose.filter((t) => t.status === stage).map((t) => t.id);
        if (ids.length) await tx.task.updateMany({ where: { id: { in: ids } }, data: { columnId: this.columnForStage(before, stage).id } });
      }

      // New columns first (moves may point at them), then the kept ones get their names and places
      const finalIds: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.id) {
          await tx.boardColumn.update({ where: { id: it.id }, data: { name: names[i], stage: it.stage, position: i } });
          finalIds.push(it.id);
        } else {
          const made = await tx.boardColumn.create({ data: { projectId, name: names[i], stage: it.stage, position: i } });
          finalIds.push(made.id);
        }
      }
      const finalCols: Column[] = items.map((it, i) => ({ id: finalIds[i], projectId, name: names[i], stage: it.stage, position: i }));

      // A kept column that now counts as another stage takes its tasks with it
      for (const it of items.filter((x) => x.id)) {
        const old = before.find((c) => c.id === it.id)!;
        if (old.stage !== it.stage) await this.moveTasks(tx, { columnId: it.id! }, it.id!, it.stage);
      }

      // Removed columns: their tasks go where the person chose (or, unasked, to the first column of the same stage)
      let moved = 0;
      for (const gone of before.filter((c) => !keptIds.has(c.id))) {
        const count = await tx.task.count({ where: { columnId: gone.id } });
        if (count) {
          const ref = moveTo[gone.id];
          let target: Column | undefined;
          if (ref?.startsWith("new:")) target = finalCols[Number(ref.slice(4))];
          else if (ref) target = finalCols.find((c) => c.id === ref);
          else target = finalCols.find((c) => c.stage === gone.stage);
          if (!target) throw new ApiError(400, `"${gone.name}" still has ${count} task${count === 1 ? "" : "s"}. Choose a column to move ${count === 1 ? "it" : "them"} to.`, { code: "MOVE_NEEDED", columnId: gone.id, count });
          moved += await this.moveTasks(tx, { columnId: gone.id }, target.id, target.stage);
        }
        await tx.boardColumn.delete({ where: { id: gone.id } });
      }
      return { columns: finalCols, moved };
    });
  }

  // Put tasks into a column, bringing their status (and completion stamps) in line with its stage
  // (a few bulk updates, not one per task: a column can hold hundreds)
  private static async moveTasks(tx: Prisma.TransactionClient, where: Prisma.TaskWhereInput, columnId: string, stage: Stage) {
    const now = new Date();
    if (stage === "DONE") await tx.task.updateMany({ where: { ...where, status: { not: "DONE" } }, data: { completedAt: now } });
    else await tx.task.updateMany({ where: { ...where, status: "DONE" }, data: { completedAt: null } });
    if (stage === "IN_PROGRESS") await tx.task.updateMany({ where: { ...where, startedAt: null }, data: { startedAt: now } });
    const r = await tx.task.updateMany({ where, data: { columnId, status: stage } });
    return r.count;
  }
}
