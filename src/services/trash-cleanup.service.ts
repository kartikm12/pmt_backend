import { prisma } from "../prisma/client.js";
import { StorageService } from "./storage.service.js";

// Recently deleted keeps projects and tasks for 30 days; after that this removes them for good, once a day.
// Comments, checklists, time entries, milestones, memberships and attachment rows go with them (onDelete:
// Cascade); their bell notifications are deleted too. Audit-log lines stay (their links are set to null).
export const KEEP_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;
// Past the 30 days an item is due for removal, so it can no longer be restored either
export const pastKeep = (deletedAt: Date, now = Date.now()) => now - deletedAt.getTime() > KEEP_DAYS * DAY_MS;

export class TrashCleanupService {
  static async run(now = new Date()) {
    const cutoff = new Date(now.getTime() - KEEP_DAYS * DAY_MS);
    const [projects, tasks] = await Promise.all([
      prisma.project.findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true } }),
      prisma.task.findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true } })
    ]);
    const projectIds = projects.map((p) => p.id);
    const taskIds = tasks.map((t) => t.id);
    if (!projectIds.length && !taskIds.length) return { projects: 0, tasks: 0, files: 0 };

    // Tasks of a purged project go with it, even ones deleted more recently on their own
    const inScope = { OR: [{ projectId: { in: projectIds } }, { taskId: { in: taskIds } }] };
    const files = await prisma.attachment.findMany({
      where: { OR: [...inScope.OR, { task: { projectId: { in: projectIds } } }] },
      select: { url: true }
    });

    // Database first: if storage then fails, the worst case is an orphan file (logged), never a broken record
    await prisma.$transaction([
      prisma.notification.deleteMany({ where: { OR: [...inScope.OR, { task: { projectId: { in: projectIds } } }] } }),
      prisma.task.deleteMany({ where: { id: { in: taskIds } } }),
      prisma.project.deleteMany({ where: { id: { in: projectIds } } })
    ]);
    for (const f of files) await StorageService.deleteFile(f.url);

    console.log(`Recently deleted clean-up: removed ${projectIds.length} project(s), ${taskIds.length} task(s) and ${files.length} file(s) older than ${KEEP_DAYS} days`);
    return { projects: projectIds.length, tasks: taskIds.length, files: files.length };
  }

  // First run a minute after start-up (so a restart never skips a day), then every 24 hours
  static start() {
    const tick = () => TrashCleanupService.run().catch((err) => console.error("Recently deleted clean-up failed:", err));
    const first = setTimeout(tick, 60_000);
    const timer = setInterval(tick, DAY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }
}
