import { addDays, subDays, startOfDay } from "date-fns";
import { prisma } from "../prisma/client.js";
import { NotificationService } from "../services/notification.service.js";

const DEFAULT_ASSET_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export class AssetScheduler {
  static async run(now = new Date()) {
    const today = startOfDay(now);
    const thirtyDaysAhead = addDays(today, 30);
    const threeDaysAgo = subDays(now, 3);

    // 1. Warranty expiring in 30 days
    const expiringAssets = await prisma.asset.findMany({
      where: {
        deletedAt: null,
        status: { in: ["IN_STOCK", "ASSIGNED", "IN_REPAIR"] },
        warrantyEndDate: { gte: today, lte: thirtyDaysAhead },
        warrantyReminderSentAt: null
      },
      include: {
        currentHolder: { select: { id: true, fullName: true, reportsToId: true } }
      }
    });

    for (const asset of expiringAssets) {
      const claim = await prisma.asset.updateMany({
        where: { id: asset.id, warrantyReminderSentAt: null },
        data: { warrantyReminderSentAt: now }
      });
      if (claim.count === 0) continue;

      const recipients = new Set<string>();
      if (asset.currentHolder?.reportsToId) {
        recipients.add(asset.currentHolder.reportsToId);
      }

      // Also notify admins
      const admins = await prisma.user.findMany({
        where: { role: "ADMIN", deletedAt: null, status: "ACTIVE" },
        select: { id: true }
      });
      for (const a of admins) recipients.add(a.id);

      for (const userId of recipients) {
        await NotificationService.create({
          userId,
          type: "ASSET_WARRANTY_EXPIRING" as any,
          title: "Asset Warranty Expiring Soon",
          message: `Warranty for ${asset.name} (${asset.assetTag}) expires on ${asset.warrantyEndDate ? asset.warrantyEndDate.toISOString().split("T")[0] : "soon"}.`,
          email: true,
          emailLink: "/assets"
        });
      }
    }

    // 2. Software Licence renewal reminder
    const expiringLicences = await prisma.asset.findMany({
      where: {
        deletedAt: null,
        category: { code: "LIC" },
        warrantyEndDate: { gte: today, lte: thirtyDaysAhead },
        renewalReminderSentAt: null
      }
    });

    for (const lic of expiringLicences) {
      const claim = await prisma.asset.updateMany({
        where: { id: lic.id, renewalReminderSentAt: null },
        data: { renewalReminderSentAt: now }
      });
      if (claim.count === 0) continue;

      const admins = await prisma.user.findMany({
        where: { role: "ADMIN", deletedAt: null, status: "ACTIVE" },
        select: { id: true }
      });

      for (const adm of admins) {
        await NotificationService.create({
          userId: adm.id,
          type: "ASSET_WARRANTY_EXPIRING" as any,
          title: "Software Licence Renewal Due",
          message: `Licence ${lic.name} (${lic.assetTag}) renewal is due by ${lic.warrantyEndDate ? lic.warrantyEndDate.toISOString().split("T")[0] : "soon"}.`,
          email: true,
          emailLink: "/assets"
        });
      }
    }

    // 3. Receipt confirmation pending for 3 days
    const pendingReceiptAssignments = await prisma.assetAssignment.findMany({
      where: {
        isCurrent: true,
        receiptStatus: "PENDING",
        assignedAt: { lte: threeDaysAgo },
        receiptReminderSentAt: null
      },
      include: {
        asset: { select: { id: true, name: true, assetTag: true } },
        user: { select: { id: true, fullName: true } }
      }
    });

    for (const assignment of pendingReceiptAssignments) {
      const claim = await prisma.assetAssignment.updateMany({
        where: { id: assignment.id, receiptReminderSentAt: null },
        data: { receiptReminderSentAt: now }
      });
      if (claim.count === 0) continue;

      // Remind the manager who assigned it
      if (assignment.assignedById) {
        await NotificationService.create({
          userId: assignment.assignedById,
          type: "ASSET_RECEIPT_PENDING" as any,
          title: "Asset Receipt Confirmation Pending",
          message: `${assignment.user.fullName} has not confirmed receipt of ${assignment.asset.name} (${assignment.asset.assetTag}) assigned 3+ days ago.`,
          email: true,
          emailLink: "/assets"
        });
      }

      // Also remind employee to confirm receipt
      await NotificationService.create({
        userId: assignment.userId,
        type: "ASSET_RECEIPT_PENDING" as any,
        title: "Reminder: Confirm Asset Receipt",
        message: `Please confirm receipt of your assigned asset: ${assignment.asset.name} (${assignment.asset.assetTag}).`,
        email: true,
        emailLink: "/assets"
      });
    }
  }

  static start() {
    const tick = () => AssetScheduler.run().catch((err) => console.error("Asset scheduler run failed:", err));
    const first = setTimeout(tick, 10_000); // 10s after startup
    const timer = setInterval(tick, DEFAULT_ASSET_SCHEDULER_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }
}

