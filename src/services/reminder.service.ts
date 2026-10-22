import { addDays, format, isSameDay, startOfDay } from "date-fns";
import { TASK_STATUS } from "../constants/enums.js";
import { prisma } from "../prisma/client.js";
import { NotificationService } from "./notification.service.js";
import { LIVE_PROJECT_STATUSES } from "../constants/enums.js";

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

// Sends each task's "due soon" and "overdue" reminder once to its assignees.
// "Due soon" = due today or tomorrow; "overdue" = due before today (same rule as the UI's red titles).
export class ReminderService {
  static async run(now = new Date()) {
    const today = startOfDay(now);
    // Paused, finished and cancelled projects don't send reminders
    const openTask = { deletedAt: null, status: { not: TASK_STATUS.DONE }, project: { deletedAt: null, status: { in: LIVE_PROJECT_STATUSES } } } as const;
    const select = {
      id: true,
      title: true,
      projectId: true,
      dueDate: true,
      assignees: { where: { deletedAt: null, status: { not: "SUSPENDED" as const } }, select: { id: true } }
    };

    const dueSoon = await prisma.task.findMany({
      where: { ...openTask, dueSoonNotifiedAt: null, dueDate: { gte: today, lt: addDays(today, 2) } },
      select
    });
    const overdue = await prisma.task.findMany({
      where: { ...openTask, overdueNotifiedAt: null, dueDate: { lt: today } },
      select
    });

    let sent = 0;
    for (const task of dueSoon) {
      // Claim first so two server instances (or overlapping runs) never double-send
      const claim = await prisma.task.updateMany({ where: { id: task.id, dueSoonNotifiedAt: null }, data: { dueSoonNotifiedAt: now } });
      if (claim.count === 0) continue;
      const when = isSameDay(task.dueDate!, now) ? "today" : "tomorrow";
      for (const { id } of task.assignees) {
        await NotificationService.create({
          userId: id,
          type: "TASK_DUE_SOON",
          title: "Task due soon",
          message: `'${task.title}' is due ${when}`,
          projectId: task.projectId,
          taskId: task.id,
          email: true
        });
        sent++;
      }
    }
    for (const task of overdue) {
      const claim = await prisma.task.updateMany({ where: { id: task.id, overdueNotifiedAt: null }, data: { overdueNotifiedAt: now } });
      if (claim.count === 0) continue;
      for (const { id } of task.assignees) {
        await NotificationService.create({
          userId: id,
          type: "TASK_OVERDUE",
          title: "Task overdue",
          message: `'${task.title}' was due on ${format(task.dueDate!, "MMM d")}`,
          projectId: task.projectId,
          taskId: task.id,
          email: true
        });
        sent++;
      }
    }
    return { dueSoonTasks: dueSoon.length, overdueTasks: overdue.length, notificationsSent: sent };
  }

  static start() {
    const interval = Number(process.env.REMINDER_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
    const tick = () => ReminderService.run().catch((err) => console.error("Reminder run failed:", err));
    const first = setTimeout(tick, 5000);
    const timer = setInterval(tick, interval);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }
}
