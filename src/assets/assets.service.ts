import { prisma } from "../prisma/client.js";
import type { Prisma } from "@prisma/client";
import { ApiError } from "../utils/apiError.js";
import { NotificationService } from "../services/notification.service.js";
import { StorageService } from "../services/storage.service.js";
import {
  isAdmin,
  isManagerRole,
  getReportingHierarchyUserIds,
  canAccessAsset,
  canManageAsset,
  managerAssetScope,
  sanitizeAssetForUser
} from "./assets.permissions.js";
import type {
  CreateAssetInput,
  UpdateAssetInput,
  AssignAssetInput,
  ReturnAssetInput,
  MarkRepairInput,
  CompleteRepairInput,
  ReportProblemInput,
  AssetFilterParams
} from "./assets.types.ts";
import { addDays, startOfDay } from "date-fns";

// Which unique field a failed save clashed on ("assetTag", "serialNumber"), or null if it wasn't a clash
function uniqueTarget(err: unknown): string | null {
  const e = err as { code?: string; meta?: { target?: string[] | string } };
  if (e?.code !== "P2002") return null;
  const t = e.meta?.target;
  return (Array.isArray(t) ? t.join(",") : t ?? "").replace(/^Asset_|_key$/g, "");
}

export class AssetService {
  /**
   * Generates next unique asset tag for a category code: ENT-<CODE>-0001
   */
  static async generateAssetTag(categoryCode: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<string> {
    const cleanCode = categoryCode.trim().toUpperCase();
    const prefix = `ENT-${cleanCode}-`;

    const existingTags = await db.asset.findMany({
      where: { assetTag: { startsWith: prefix } },
      select: { assetTag: true }
    });

    let maxNum = 0;
    for (const row of existingTags) {
      const suffix = row.assetTag.substring(prefix.length);
      const num = parseInt(suffix, 10);
      if (!isNaN(num) && num > maxNum) {
        maxNum = num;
      }
    }

    const nextNum = (maxNum + 1).toString().padStart(4, "0");
    return `${prefix}${nextNum}`;
  }

  /**
   * Validates case-insensitive serial number uniqueness across all assets (including deleted)
   */
  static async validateSerialNumberUnique(serialNumber?: string | null, excludeAssetId?: string): Promise<void> {
    if (!serialNumber || !serialNumber.trim()) return;

    const trimmed = serialNumber.trim();
    const existing = await prisma.asset.findFirst({
      where: {
        serialNumber: { equals: trimmed, mode: "insensitive" },
        id: excludeAssetId ? { not: excludeAssetId } : undefined
      },
      select: { id: true }
    });

    if (existing) {
      throw new ApiError(400, `An asset with serial number '${serialNumber}' already exists.`);
    }
  }

  /**
   * List assets with summary metrics, role-scoping, search, and filters.
   */
  static async listAssets(
    user: { id: string; role: string },
    filters: AssetFilterParams
  ) {
    const {
      search,
      categoryId,
      status,
      holderId,
      warrantyExpiry,
      page = 1,
      limit = 20,
      sortBy = "createdAt",
      sortOrder = "desc",
      includeDeleted = false
    } = filters;

    const admin = isAdmin(user.role);
    const manager = isManagerRole(user.role);

    // Employees cannot access the general asset register
    if (!admin && !manager) {
      throw new ApiError(403, "Employees cannot access the Asset Register. Please use My Assets.");
    }

    // Determine manager hierarchy if manager
    let hierarchyUserIds: string[] = [];
    if (manager && !admin) {
      hierarchyUserIds = await getReportingHierarchyUserIds(user.id);
      hierarchyUserIds.push(user.id); // Manager's own assets
    }

    // Base scoping condition
    const scopeCondition: any = {
      deletedAt: includeDeleted && admin ? { not: null } : null
    };

    if (manager && !admin) {
      // Manager can see: assets assigned to subordinates/self, or unassigned inventory (currentHolderId: null)
      // Their team's items, the shared in-stock pool, and unheld items that are theirs (repair/lost/retired)
      scopeCondition.OR = managerAssetScope(user.id, hierarchyUserIds);
    }

    // Apply filters
    const where: any = { ...scopeCondition };

    if (categoryId && categoryId !== "All") {
      where.categoryId = categoryId;
    }

    if (status && status !== "All") {
      where.status = status;
    }

    if (holderId && holderId !== "All") {
      where.currentHolderId = holderId;
    }

    // Search
    if (search && search.trim()) {
      const q = search.trim();
      const searchConditions: any[] = [
        { assetTag: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
        { brand: { contains: q, mode: "insensitive" } },
        { model: { contains: q, mode: "insensitive" } }
      ];

      // Serial number search authorized for Admin & Manager
      if (admin || manager) {
        searchConditions.push({ serialNumber: { contains: q, mode: "insensitive" } });
      }

      where.AND = where.AND ? [...where.AND, { OR: searchConditions }] : [{ OR: searchConditions }];
    }

    // Warranty filter
    if (warrantyExpiry && warrantyExpiry !== "all") {
      const now = new Date();
      if (warrantyExpiry === "expired") {
        where.warrantyEndDate = { lt: now };
      } else if (warrantyExpiry === "30_days") {
        where.warrantyEndDate = { gte: now, lte: addDays(now, 30) };
      } else if (warrantyExpiry === "60_days") {
        where.warrantyEndDate = { gte: now, lte: addDays(now, 60) };
      } else if (warrantyExpiry === "valid") {
        where.warrantyEndDate = { gte: now };
      }
    }

    const skip = (Math.max(1, page) - 1) * Math.max(1, limit);

    // Compute 6 dynamic summary cards based on the scoped assets (excluding soft-deleted)
    const baseSummaryWhere = {
      deletedAt: null,
      ...(manager && !admin ? { OR: scopeCondition.OR } : {})
    };

    const [totalAssets, assignedCount, inStockCount, inRepairCount, lostCount, retiredCount] = await Promise.all([
      prisma.asset.count({ where: baseSummaryWhere }),
      prisma.asset.count({ where: { ...baseSummaryWhere, status: "ASSIGNED" } }),
      prisma.asset.count({ where: { ...baseSummaryWhere, status: "IN_STOCK" } }),
      prisma.asset.count({ where: { ...baseSummaryWhere, status: "IN_REPAIR" } }),
      prisma.asset.count({ where: { ...baseSummaryWhere, status: "LOST" } }),
      prisma.asset.count({ where: { ...baseSummaryWhere, status: "RETIRED" } })
    ]);

    // Query paginated assets
    const [totalCount, items] = await Promise.all([
      prisma.asset.count({ where }),
      prisma.asset.findMany({
        where,
        include: {
          category: { select: { id: true, name: true, code: true } },
          currentHolder: { select: { id: true, fullName: true, email: true, avatarUrl: true, title: true } },
          project: { select: { id: true, name: true } },
          assignments: {
            where: { isCurrent: true },
            take: 1,
            select: {
              id: true,
              assignedAt: true,
              receiptStatus: true,
              collectionStatus: true,
              assignmentCondition: true
            }
          }
        },
        orderBy: { [sortBy]: sortOrder },
        skip,
        take: Math.max(1, limit)
      })
    ]);

    const sanitizedItems = items.map((asset) => {
      const sanitized = sanitizeAssetForUser(asset, user.role);
      const activeAssignment = asset.assignments[0] || null;
      return {
        ...sanitized,
        activeAssignment
      };
    });

    return {
      summary: {
        totalAssets,
        assigned: assignedCount,
        inStock: inStockCount,
        inRepair: inRepairCount,
        lost: lostCount,
        retired: retiredCount
      },
      pagination: {
        total: totalCount,
        page: Math.max(1, page),
        limit: Math.max(1, limit),
        totalPages: Math.ceil(totalCount / Math.max(1, limit))
      },
      items: sanitizedItems
    };
  }

  /**
   * Get single asset by ID with full details, history & files.
   * Returns 404 for unauthorized access.
   */
  static async getAssetById(id: string, user: { id: string; role: string }) {
    const asset = await prisma.asset.findUnique({
      where: { id },
      include: {
        category: true,
        currentHolder: {
          select: { id: true, fullName: true, email: true, avatarUrl: true, title: true, role: true }
        },
        project: { select: { id: true, name: true } },
        createdBy: { select: { id: true, fullName: true } },
        assignments: {
          where: { isCurrent: true },
          take: 1,
          select: {
            id: true,
            assignedAt: true,
            receiptStatus: true,
            receiptConfirmedAt: true,
            collectionStatus: true,
            assignmentCondition: true,
            notes: true
          }
        },
        files: {
          orderBy: { createdAt: "desc" }
        }
      }
    });

    if (!asset) {
      throw new ApiError(404, "Asset not found");
    }

    // Check soft delete access
    if (asset.deletedAt && !isAdmin(user.role)) {
      throw new ApiError(404, "Asset not found");
    }

    // Check authorization: return 404 on forbidden to prevent IDOR
    const allowed = await canAccessAsset(user, asset);
    if (!allowed) {
      throw new ApiError(404, "Asset not found");
    }

    // Resolve file signed URLs
    const filesWithUrls = await Promise.all(
      asset.files.map(async (file) => {
        let signedUrl = file.url;
        try {
          signedUrl = await StorageService.openUrl(file.url, file.name);
        } catch {
          // fallback to ref if signing fails
        }
        return {
          ...file,
          downloadUrl: signedUrl
        };
      })
    );

    const sanitized = sanitizeAssetForUser(
      {
        ...asset,
        activeAssignment: asset.assignments[0] || null,
        files: filesWithUrls
      },
      user.role
    );

    // Lets the page show only the buttons this person may use (each action still checks on its own)
    const canManage = await canManageAsset(user, asset);
    return { ...sanitized, canManage, isHolder: asset.currentHolderId === user.id };
  }

  /**
   * Create an asset (4-section form).
   */
  static async createAsset(
    user: { id: string; role: string },
    input: CreateAssetInput
  ) {
    if (!isAdmin(user.role) && !isManagerRole(user.role)) {
      throw new ApiError(403, "Only Admins and Managers can add assets");
    }

    // Validate category exists
    const category = await prisma.assetCategory.findUnique({
      where: { id: input.categoryId }
    });
    if (!category) {
      throw new ApiError(400, "Invalid asset category");
    }

    // Validate serial number uniqueness
    if (input.serialNumber) {
      await this.validateSerialNumberUnique(input.serialNumber);
    }

    // If assigning to employee, validate employee
    let targetEmployee: any = null;
    if (input.assignmentType === "ASSIGN") {
      if (!input.employeeId) {
        throw new ApiError(400, "Employee selection is required when assigning asset");
      }

      targetEmployee = await prisma.user.findFirst({
        where: { id: input.employeeId, deletedAt: null }
      });

      if (!targetEmployee) {
        throw new ApiError(400, "Assigned employee not found");
      }

      if (targetEmployee.status === "SUSPENDED") {
        throw new ApiError(400, "Cannot assign assets to a suspended employee");
      }

      // If manager, check employee is in manager's hierarchy
      if (!isAdmin(user.role)) {
        const hierarchy = await getReportingHierarchyUserIds(user.id);
        if (!hierarchy.includes(input.employeeId) && input.employeeId !== user.id) {
          throw new ApiError(403, "You can only assign assets to employees within your reporting hierarchy");
        }
      }
    }

    const isAssign = input.assignmentType === "ASSIGN" && input.employeeId;
    const initialStatus = isAssign ? "ASSIGNED" : "IN_STOCK";

    // Two people adding a laptop in the same second would both get the next free tag: the second save then
    // hits the unique tag and simply tries the following number (a few times) instead of failing.
    let createdAsset!: Awaited<ReturnType<typeof prisma.asset.create>>;
    for (let attempt = 0; ; attempt++) {
    let assetTag = "";
    try {
    createdAsset = await prisma.$transaction(async (tx) => {
      // Additions in the same category queue here for a moment (released when this save ends), so each one
      // sees the tag the one before it took: 12 laptops added at once get 12 different numbers.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"asset-tag:" + category.code.toUpperCase()}))`;
      assetTag = await this.generateAssetTag(category.code, tx);
      const asset = await tx.asset.create({
        data: {
          assetTag,
          name: input.name.trim(),
          categoryId: input.categoryId,
          brand: input.brand?.trim() || null,
          model: input.model?.trim() || null,
          serialNumber: input.serialNumber?.trim() || null,
          specifications: input.specifications?.trim() || null,
          condition: input.condition,
          status: initialStatus,
          location: input.location?.trim() || null,
          purchaseDate: input.purchaseDate && input.purchaseDate.trim() !== "" ? new Date(input.purchaseDate) : null,
          purchaseCost: input.purchaseCost !== undefined && input.purchaseCost !== null ? Number(input.purchaseCost) : null,
          vendorName: input.vendorName?.trim() || null,
          warrantyStartDate: input.warrantyStartDate && input.warrantyStartDate.trim() !== "" ? new Date(input.warrantyStartDate) : null,
          warrantyEndDate: input.warrantyEndDate && input.warrantyEndDate.trim() !== "" ? new Date(input.warrantyEndDate) : null,
          currentHolderId: isAssign ? input.employeeId : null,
          projectId: isAssign && input.projectId ? input.projectId : null,
          createdById: user.id
        }
      });

      // Event: Created
      await tx.assetEvent.create({
        data: {
          assetId: asset.id,
          eventType: "CREATED",
          performedById: user.id,
          title: "Asset Registered",
          description: `Asset registered with Tag ${assetTag} by ${user.role}`,
          metadata: { initialStatus }
        }
      });

      // If assigned immediately
      if (isAssign && input.employeeId) {
        await tx.assetAssignment.create({
          data: {
            assetId: asset.id,
            userId: input.employeeId,
            projectId: input.projectId || null,
            assignedById: user.id,
            assignedAt: new Date(),
            assignmentCondition: input.assignmentCondition || input.condition,
            notes: input.notes?.trim() || null,
            receiptStatus: "PENDING",
            isCurrent: true
          }
        });

        await tx.assetEvent.create({
          data: {
            assetId: asset.id,
            eventType: "ASSIGNED",
            performedById: user.id,
            title: "Asset Assigned",
            description: `Assigned to ${targetEmployee.fullName}`,
            metadata: {
              employeeId: input.employeeId,
              employeeName: targetEmployee.fullName,
              condition: input.assignmentCondition || input.condition
            }
          }
        });
      }

      return asset;
    });
    break;
    } catch (err) {
      const target = uniqueTarget(err);
      if (target === "assetTag" && attempt < 5) continue;
      if (target === "serialNumber") throw new ApiError(400, `An asset with serial number '${input.serialNumber}' already exists.`);
      throw err;
    }
    }

    // Send notifications if assigned
    if (isAssign && input.employeeId && targetEmployee) {
      await NotificationService.create({
        userId: input.employeeId,
        assetId: createdAsset.id,
        type: "ASSET_ASSIGNED" as any,
        title: "New Asset Assigned",
        message: `You have been assigned a new asset: ${createdAsset.name} (${createdAsset.assetTag}). Please confirm receipt.`,
        email: true,
        emailLink: "/assets"
      });
    }

    return this.getAssetById(createdAsset.id, user);
  }

  /**
   * Update asset details.
   */
  static async updateAsset(
    id: string,
    user: { id: string; role: string },
    input: UpdateAssetInput
  ) {
    const asset = await prisma.asset.findUnique({ where: { id } });
    if (!asset || (asset.deletedAt && !isAdmin(user.role))) {
      throw new ApiError(404, "Asset not found");
    }

    const canManage = await canManageAsset(user, asset);
    if (!canManage) {
      throw new ApiError(403, "You are not authorized to edit this asset");
    }

    if (input.serialNumber && input.serialNumber.trim() !== asset.serialNumber) {
      await this.validateSerialNumberUnique(input.serialNumber, id);
    }

    const previousValues: Record<string, any> = {};
    const newValues: Record<string, any> = {};

    const fieldsToTrack: (keyof UpdateAssetInput)[] = [
      "name", "brand", "model", "serialNumber", "condition", "location", "vendorName"
    ];

    for (const f of fieldsToTrack) {
      if (input[f] !== undefined && input[f] !== (asset as any)[f]) {
        previousValues[f] = (asset as any)[f];
        newValues[f] = input[f];
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const res = await tx.asset.update({
        where: { id },
        data: {
          name: input.name?.trim(),
          categoryId: input.categoryId,
          brand: input.brand !== undefined ? (input.brand?.trim() || null) : undefined,
          model: input.model !== undefined ? (input.model?.trim() || null) : undefined,
          serialNumber: input.serialNumber !== undefined ? (input.serialNumber?.trim() || null) : undefined,
          specifications: input.specifications !== undefined ? (input.specifications?.trim() || null) : undefined,
          condition: input.condition,
          location: input.location !== undefined ? (input.location?.trim() || null) : undefined,
          purchaseDate: input.purchaseDate !== undefined ? (input.purchaseDate ? new Date(input.purchaseDate) : null) : undefined,
          purchaseCost: input.purchaseCost !== undefined ? (input.purchaseCost !== null ? Number(input.purchaseCost) : null) : undefined,
          vendorName: input.vendorName !== undefined ? (input.vendorName?.trim() || null) : undefined,
          warrantyStartDate: input.warrantyStartDate !== undefined ? (input.warrantyStartDate ? new Date(input.warrantyStartDate) : null) : undefined,
          warrantyEndDate: input.warrantyEndDate !== undefined ? (input.warrantyEndDate ? new Date(input.warrantyEndDate) : null) : undefined
        }
      });

      if (Object.keys(newValues).length > 0) {
        await tx.assetEvent.create({
          data: {
            assetId: id,
            eventType: "UPDATED",
            performedById: user.id,
            title: "Asset Details Updated",
            description: "Asset details were modified",
            metadata: { previousValues, newValues }
          }
        });
      }

      return res;
    });

    return this.getAssetById(updated.id, user);
  }

  /**
   * Assign asset to employee (with concurrency check).
   */
  static async assignAsset(
    id: string,
    user: { id: string; role: string },
    input: AssignAssetInput
  ) {
    if (!isAdmin(user.role) && !isManagerRole(user.role)) {
      throw new ApiError(403, "Only Admins and Managers can assign assets");
    }

    const targetEmployee = await prisma.user.findFirst({
      where: { id: input.employeeId, deletedAt: null }
    });

    if (!targetEmployee) {
      throw new ApiError(400, "Assigned employee not found");
    }

    if (targetEmployee.status === "SUSPENDED") {
      throw new ApiError(400, "Cannot assign assets to a suspended employee");
    }

    // Hierarchy check for manager
    if (!isAdmin(user.role)) {
      const hierarchy = await getReportingHierarchyUserIds(user.id);
      if (!hierarchy.includes(input.employeeId) && input.employeeId !== user.id) {
        throw new ApiError(403, "You can only assign assets to employees within your reporting hierarchy");
      }
    }

    // Transaction with optimistic concurrency check
    const updated = await prisma.$transaction(async (tx) => {
      const asset = await tx.asset.findUnique({
        where: { id }
      });

      if (!asset || asset.deletedAt) {
        throw new ApiError(404, "Asset not found");
      }

      if (asset.status === "RETIRED") {
        throw new ApiError(400, "Cannot assign a retired asset");
      }

      if (asset.status === "LOST") {
        throw new ApiError(400, "Cannot assign a lost asset");
      }

      // Claim it in the same statement that checks it: two managers assigning the same laptop in the same
      // second can both pass a read-then-write check; here the second one waits for the first, then finds
      // it taken (0 rows) and gets the 409. (The old check only read.)
      const claimed = await tx.asset.updateMany({
        where: {
          id,
          deletedAt: null,
          status: { notIn: ["RETIRED", "LOST"] },
          NOT: { status: "ASSIGNED", currentHolderId: { not: null } }
        },
        data: { status: "ASSIGNED", currentHolderId: input.employeeId }
      });
      if (claimed.count === 0) {
        throw new ApiError(409, "This asset has already been assigned.");
      }

      // Close any stray open assignments
      await tx.assetAssignment.updateMany({
        where: { assetId: id, isCurrent: true },
        data: { isCurrent: false, returnedAt: new Date() }
      });

      // Create new active assignment
      await tx.assetAssignment.create({
        data: {
          assetId: id,
          userId: input.employeeId,
          projectId: input.projectId || null,
          assignedById: user.id,
          assignedAt: new Date(),
          assignmentCondition: input.assignmentCondition || asset.condition,
          notes: input.notes?.trim() || null,
          receiptStatus: "PENDING",
          isCurrent: true
        }
      });

      // Update asset record
      const res = await tx.asset.update({
        where: { id },
        data: {
          status: "ASSIGNED",
          currentHolderId: input.employeeId,
          projectId: input.projectId || null,
          condition: input.assignmentCondition || asset.condition
        }
      });

      // Log event
      await tx.assetEvent.create({
        data: {
          assetId: id,
          eventType: "ASSIGNED",
          performedById: user.id,
          title: "Asset Assigned",
          description: `Assigned to ${targetEmployee.fullName}`,
          metadata: {
            employeeId: input.employeeId,
            employeeName: targetEmployee.fullName,
            condition: input.assignmentCondition || asset.condition,
            notes: input.notes || null
          }
        }
      });

      return res;
    });

    // In-app & email notification to employee
    await NotificationService.create({
      userId: input.employeeId,
      assetId: updated.id,
      type: "ASSET_ASSIGNED" as any,
      title: "New Asset Assigned",
      message: `You have been assigned a new asset: ${updated.name} (${updated.assetTag}). Please confirm receipt.`,
      email: true,
      emailLink: "/assets"
    });

    return this.getAssetById(updated.id, user);
  }

  /**
   * Employee confirms receipt: "I Received It"
   */
  static async confirmReceipt(id: string, user: { id: string; role: string }) {
    const asset = await prisma.asset.findUnique({
      where: { id },
      include: {
        assignments: {
          where: { isCurrent: true, userId: user.id },
          take: 1
        }
      }
    });

    if (!asset || asset.deletedAt) {
      throw new ApiError(404, "Asset not found");
    }

    if (asset.currentHolderId !== user.id || asset.assignments.length === 0) {
      throw new ApiError(403, "You can only confirm receipt for assets assigned to you");
    }

    const currentAssignment = asset.assignments[0];
    if (currentAssignment.receiptStatus === "CONFIRMED") {
      throw new ApiError(400, "Receipt has already been confirmed for this asset");
    }

    await prisma.$transaction(async (tx) => {
      await tx.assetAssignment.update({
        where: { id: currentAssignment.id },
        data: {
          receiptStatus: "CONFIRMED",
          receiptConfirmedAt: new Date()
        }
      });

      await tx.assetEvent.create({
        data: {
          assetId: id,
          eventType: "RECEIPT_CONFIRMED",
          performedById: user.id,
          title: "Receipt Confirmed",
          description: `Receipt confirmed by ${user.id}`,
          metadata: { confirmedAt: new Date() }
        }
      });
    });

    // Notify assigning manager
    if (currentAssignment.assignedById && currentAssignment.assignedById !== user.id) {
      const currentUser = await prisma.user.findUnique({ where: { id: user.id }, select: { fullName: true } });
      await NotificationService.create({
        userId: currentAssignment.assignedById,
        assetId: asset.id,
        type: "ASSET_RECEIPT_CONFIRMED" as any,
        title: "Asset Receipt Confirmed",
        message: `${currentUser?.fullName || "Employee"} confirmed receipt of ${asset.name} (${asset.assetTag}).`,
        email: true,
        emailLink: "/assets"
      });
    }

    return this.getAssetById(id, user);
  }

  /**
   * Return asset: closes assignment and dispatches to Stock or Repair.
   */
  static async returnAsset(
    id: string,
    user: { id: string; role: string },
    input: ReturnAssetInput
  ) {
    const asset = await prisma.asset.findUnique({
      where: { id },
      include: {
        assignments: { where: { isCurrent: true }, take: 1 },
        currentHolder: { select: { id: true, fullName: true } }
      }
    });

    if (!asset || asset.deletedAt) {
      throw new ApiError(404, "Asset not found");
    }

    const canManage = await canManageAsset(user, asset);
    if (!canManage) {
      throw new ApiError(403, "You are not authorized to process returns for this asset");
    }

    const currentAssignment = asset.assignments[0];
    const newStatus = input.returnDisposition === "REPAIR" ? "IN_REPAIR" : "IN_STOCK";

    await prisma.$transaction(async (tx) => {
      if (currentAssignment) {
        await tx.assetAssignment.update({
          where: { id: currentAssignment.id },
          data: {
            isCurrent: false,
            returnedAt: input.returnDate ? new Date(input.returnDate) : new Date(),
            returnCondition: input.returnCondition,
            returnRemarks: input.returnRemarks?.trim() || null,
            returnDisposition: input.returnDisposition,
            returnedById: user.id,
            collectionStatus: "COLLECTED"
          }
        });
      }

      await tx.asset.update({
        where: { id },
        data: {
          status: newStatus,
          condition: input.returnCondition,
          currentHolderId: null,
          projectId: null
        }
      });

      await tx.assetEvent.create({
        data: {
          assetId: id,
          eventType: "RETURNED",
          performedById: user.id,
          title: "Asset Returned",
          description: `Returned from ${asset.currentHolder?.fullName || "Employee"} (Disposition: ${input.returnDisposition})`,
          metadata: {
            condition: input.returnCondition,
            remarks: input.returnRemarks,
            disposition: input.returnDisposition,
            previousHolder: asset.currentHolder?.fullName
          }
        }
      });
    });

    return this.getAssetById(id, user);
  }

  /**
   * Mark asset as In Repair.
   */
  static async markForRepair(
    id: string,
    user: { id: string; role: string },
    input: MarkRepairInput
  ) {
    const asset = await prisma.asset.findUnique({
      where: { id },
      include: { assignments: { where: { isCurrent: true }, take: 1 } }
    });

    if (!asset || asset.deletedAt) {
      throw new ApiError(404, "Asset not found");
    }

    const canManage = await canManageAsset(user, asset);
    if (!canManage) {
      throw new ApiError(403, "You are not authorized to mark this asset for repair");
    }

    await prisma.$transaction(async (tx) => {
      // If currently assigned, close assignment
      if (asset.assignments[0]) {
        await tx.assetAssignment.update({
          where: { id: asset.assignments[0].id },
          data: {
            isCurrent: false,
            returnedAt: new Date(),
            returnDisposition: "REPAIR",
            returnRemarks: input.problemDescription
          }
        });
      }

      await tx.asset.update({
        where: { id },
        data: {
          status: "IN_REPAIR",
          currentHolderId: null
        }
      });

      await tx.assetEvent.create({
        data: {
          assetId: id,
          eventType: "MARKED_FOR_REPAIR",
          performedById: user.id,
          title: "Marked For Repair",
          description: input.problemDescription,
          metadata: { remarks: input.remarks }
        }
      });
    });

    return this.getAssetById(id, user);
  }

  /**
   * Complete repair and restore to Stock or reassign.
   */
  static async completeRepair(
    id: string,
    user: { id: string; role: string },
    input: CompleteRepairInput
  ) {
    const asset = await prisma.asset.findUnique({ where: { id } });
    if (!asset || asset.deletedAt) {
      throw new ApiError(404, "Asset not found");
    }

    const canManage = await canManageAsset(user, asset);
    if (!canManage) {
      throw new ApiError(403, "You are not authorized to complete repair for this asset");
    }

    if (asset.status !== "IN_REPAIR") {
      throw new ApiError(400, "Asset is not currently in repair");
    }

    const isAssign = input.disposition === "ASSIGN" && input.employeeId;

    await prisma.$transaction(async (tx) => {
      await tx.asset.update({
        where: { id },
        data: {
          status: isAssign ? "ASSIGNED" : "IN_STOCK",
          condition: input.condition,
          currentHolderId: isAssign ? input.employeeId : null,
          projectId: isAssign && input.projectId ? input.projectId : null
        }
      });

      if (isAssign && input.employeeId) {
        await tx.assetAssignment.create({
          data: {
            assetId: id,
            userId: input.employeeId,
            projectId: input.projectId || null,
            assignedById: user.id,
            assignedAt: new Date(),
            assignmentCondition: input.condition,
            notes: input.remarks || null,
            receiptStatus: "PENDING",
            isCurrent: true
          }
        });
      }

      await tx.assetEvent.create({
        data: {
          assetId: id,
          eventType: "REPAIR_COMPLETED",
          performedById: user.id,
          title: "Repair Completed",
          description: `Repair completed. Condition: ${input.condition}. Disposition: ${input.disposition}`,
          metadata: {
            condition: input.condition,
            disposition: input.disposition,
            remarks: input.remarks
          }
        }
      });
    });

    return this.getAssetById(id, user);
  }

  /**
   * Mark asset as Lost.
   */
  static async markLost(
    id: string,
    user: { id: string; role: string },
    remarks?: string
  ) {
    const asset = await prisma.asset.findUnique({
      where: { id },
      include: { assignments: { where: { isCurrent: true }, take: 1 } }
    });

    if (!asset || asset.deletedAt) {
      throw new ApiError(404, "Asset not found");
    }

    const canManage = await canManageAsset(user, asset);
    if (!canManage) {
      throw new ApiError(403, "You are not authorized to mark this asset as lost");
    }

    await prisma.$transaction(async (tx) => {
      if (asset.assignments[0]) {
        await tx.assetAssignment.update({
          where: { id: asset.assignments[0].id },
          data: {
            isCurrent: false,
            returnedAt: new Date(),
            returnRemarks: remarks || "Asset marked lost"
          }
        });
      }

      await tx.asset.update({
        where: { id },
        data: {
          status: "LOST",
          currentHolderId: null
        }
      });

      await tx.assetEvent.create({
        data: {
          assetId: id,
          eventType: "MARKED_LOST",
          performedById: user.id,
          title: "Asset Marked Lost",
          description: remarks || "Asset reported lost",
          metadata: { remarks }
        }
      });
    });

    return this.getAssetById(id, user);
  }

  /**
   * Retire asset (Admin only).
   */
  static async retireAsset(
    id: string,
    user: { id: string; role: string },
    remarks?: string
  ) {
    if (!isAdmin(user.role)) {
      throw new ApiError(403, "Only Admins can retire assets");
    }

    const asset = await prisma.asset.findUnique({
      where: { id },
      include: { assignments: { where: { isCurrent: true }, take: 1 } }
    });

    if (!asset || asset.deletedAt) {
      throw new ApiError(404, "Asset not found");
    }

    await prisma.$transaction(async (tx) => {
      if (asset.assignments[0]) {
        await tx.assetAssignment.update({
          where: { id: asset.assignments[0].id },
          data: {
            isCurrent: false,
            returnedAt: new Date(),
            returnRemarks: remarks || "Asset retired"
          }
        });
      }

      await tx.asset.update({
        where: { id },
        data: {
          status: "RETIRED",
          currentHolderId: null
        }
      });

      await tx.assetEvent.create({
        data: {
          assetId: id,
          eventType: "RETIRED",
          performedById: user.id,
          title: "Asset Retired",
          description: remarks || "Asset formally retired",
          metadata: { remarks }
        }
      });
    });

    return this.getAssetById(id, user);
  }

  /**
   * Soft delete asset (Admin only, 30-day retention).
   */
  static async softDeleteAsset(id: string, user: { id: string; role: string }) {
    if (!isAdmin(user.role)) {
      throw new ApiError(403, "Only Admins can delete assets");
    }

    const asset = await prisma.asset.findUnique({ where: { id } });
    if (!asset || asset.deletedAt) {
      throw new ApiError(404, "Asset not found");
    }

    await prisma.$transaction(async (tx) => {
      await tx.asset.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          currentHolderId: null
        }
      });

      await tx.assetAssignment.updateMany({
        where: { assetId: id, isCurrent: true },
        data: { isCurrent: false, returnedAt: new Date(), returnRemarks: "Asset moved to trash" }
      });

      await tx.assetEvent.create({
        data: {
          assetId: id,
          eventType: "DELETED",
          performedById: user.id,
          title: "Asset Moved to Recently Deleted",
          description: "Asset moved to trash (retained for 30 days)"
        }
      });
    });

    return { success: true };
  }

  /**
   * Restore soft-deleted asset (Admin only).
   */
  static async restoreAsset(id: string, user: { id: string; role: string }) {
    if (!isAdmin(user.role)) {
      throw new ApiError(403, "Only Admins can restore deleted assets");
    }

    const asset = await prisma.asset.findUnique({ where: { id } });
    if (!asset || !asset.deletedAt) {
      throw new ApiError(404, "Deleted asset not found");
    }

    await prisma.$transaction(async (tx) => {
      await tx.asset.update({
        where: { id },
        data: {
          deletedAt: null,
          status: "IN_STOCK",
          currentHolderId: null
        }
      });

      await tx.assetEvent.create({
        data: {
          assetId: id,
          eventType: "RESTORED",
          performedById: user.id,
          title: "Asset Restored",
          description: "Asset restored from Recently Deleted"
        }
      });
    });

    return this.getAssetById(id, user);
  }

  /**
   * Employee reports a problem on their assigned asset.
   */
  static async reportProblem(
    id: string,
    user: { id: string; role: string },
    input: ReportProblemInput
  ) {
    const asset = await prisma.asset.findUnique({
      where: { id },
      include: {
        currentHolder: { select: { id: true, fullName: true, reportsToId: true } }
      }
    });

    if (!asset || asset.deletedAt) {
      throw new ApiError(404, "Asset not found");
    }

    if (asset.currentHolderId !== user.id && !isAdmin(user.role)) {
      throw new ApiError(403, "You can only report problems for assets currently assigned to you");
    }

    await prisma.assetEvent.create({
      data: {
        assetId: id,
        eventType: "PROBLEM_REPORTED",
        performedById: user.id,
        title: `Problem Reported: ${input.problemCategory}`,
        description: input.description,
        metadata: {
          problemCategory: input.problemCategory,
          photoUrl: input.photoUrl || null
        }
      }
    });

    // Notify employee's reporting manager and Admin
    const managerId = asset.currentHolder?.reportsToId;
    const holderName = asset.currentHolder?.fullName || "An employee";

    if (managerId) {
      await NotificationService.create({
        userId: managerId,
        assetId: asset.id,
        type: "ASSET_PROBLEM_REPORTED" as any,
        title: "Asset Problem Reported",
        message: `${holderName} reported an issue with ${asset.name} (${asset.assetTag}): ${input.description.slice(0, 80)}...`,
        email: true,
        emailLink: "/assets"
      });
    }

    // Also notify admins
    const admins = await prisma.user.findMany({
      where: { role: "ADMIN", deletedAt: null, status: "ACTIVE" },
      select: { id: true }
    });
    for (const adm of admins) {
      if (adm.id !== managerId && adm.id !== user.id) {
        await NotificationService.create({
          userId: adm.id,
          assetId: asset.id,
          type: "ASSET_PROBLEM_REPORTED" as any,
          title: "Asset Problem Reported",
          message: `${holderName} reported an issue with ${asset.name} (${asset.assetTag}).`,
          email: false
        });
      }
    }

    return { success: true, message: "Problem reported successfully" };
  }

  /**
   * My Assets: Available to all employees.
   */
  static async getMyAssets(userId: string) {
    const assets = await prisma.asset.findMany({
      where: {
        currentHolderId: userId,
        deletedAt: null
      },
      include: {
        category: { select: { id: true, name: true, code: true } },
        project: { select: { id: true, name: true } },
        assignments: {
          where: { isCurrent: true, userId },
          take: 1,
          select: {
            id: true,
            assignedAt: true,
            receiptStatus: true,
            receiptConfirmedAt: true,
            assignmentCondition: true
          }
        }
      },
      orderBy: { createdAt: "desc" }
    });

    return assets.map((a) => {
      const activeAssignment = a.assignments[0] || null;
      // Redact sensitive cost and serial number
      const sanitized = sanitizeAssetForUser(a, "DEVELOPER");
      return {
        ...sanitized,
        activeAssignment
      };
    });
  }

  /**
   * Team Assets: Available to Managers & Admins.
   */
  static async getTeamAssets(managerId: string, userRole: string) {
    if (!isAdmin(userRole) && !isManagerRole(userRole)) {
      throw new ApiError(403, "Access restricted to Managers and Admins");
    }

    let subordinateIds: string[] = [];
    if (isAdmin(userRole)) {
      const allActive = await prisma.user.findMany({
        where: { deletedAt: null },
        select: { id: true }
      });
      subordinateIds = allActive.map((u) => u.id);
    } else {
      subordinateIds = await getReportingHierarchyUserIds(managerId);
      subordinateIds.push(managerId);
    }

    const where: Prisma.AssetWhereInput = {
      deletedAt: null,
      OR: [
        { currentHolderId: { in: subordinateIds } },
        {
          status: "IN_REPAIR",
          assignments: { some: { userId: { in: subordinateIds } } }
        }
      ]
    };

    const [totalTeamAssets, assignedCount, inRepairCount, pendingCollectionCount, items] = await Promise.all([
      prisma.asset.count({ where }),
      prisma.asset.count({ where: { ...where, status: "ASSIGNED" } }),
      prisma.asset.count({ where: { ...where, status: "IN_REPAIR" } }),
      prisma.asset.count({
        where: {
          ...where,
          assignments: { some: { isCurrent: true, collectionStatus: "PENDING_COLLECTION" } }
        }
      }),
      prisma.asset.findMany({
        where,
        include: {
          category: { select: { id: true, name: true, code: true } },
          currentHolder: {
            select: { id: true, fullName: true, email: true, avatarUrl: true, title: true, role: true }
          },
          project: { select: { id: true, name: true } },
          assignments: {
            where: { isCurrent: true },
            take: 1,
            select: {
              id: true,
              assignedAt: true,
              receiptStatus: true,
              collectionStatus: true,
              assignmentCondition: true
            }
          }
        },
        orderBy: { createdAt: "desc" }
      })
    ]);

    const sanitizedItems = items.map((asset) => {
      const sanitized = sanitizeAssetForUser(asset, userRole);
      return {
        ...sanitized,
        activeAssignment: asset.assignments[0] || null
      };
    });

    return {
      summary: {
        totalTeamAssets,
        assigned: assignedCount,
        inRepair: inRepairCount,
        pendingCollection: pendingCollectionCount
      },
      items: sanitizedItems
    };
  }

  /**
   * Recently Deleted: Admin only.
   */
  static async getRecentlyDeleted(user: { id: string; role: string }) {
    if (!isAdmin(user.role)) {
      throw new ApiError(403, "Access restricted to Admins");
    }

    const items = await prisma.asset.findMany({
      where: {
        deletedAt: { not: null }
      },
      include: {
        category: { select: { id: true, name: true, code: true } },
        createdBy: { select: { id: true, fullName: true } }
      },
      orderBy: { deletedAt: "desc" }
    });

    return items;
  }

  /**
   * Asset History timeline.
   */
  static async getAssetHistory(assetId: string, user: { id: string; role: string }) {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      select: { id: true, currentHolderId: true, status: true, createdById: true, deletedAt: true }
    });

    if (!asset || (asset.deletedAt && !isAdmin(user.role))) {
      throw new ApiError(404, "Asset not found");
    }

    const allowed = await canAccessAsset(user, asset);
    if (!allowed) {
      throw new ApiError(404, "Asset not found");
    }

    const events = await prisma.assetEvent.findMany({
      where: { assetId },
      include: {
        performedBy: {
          select: { id: true, fullName: true, avatarUrl: true, role: true }
        }
      },
      orderBy: { createdAt: "desc" }
    });

    return events;
  }

  /**
   * Upload asset photograph (private storage).
   */
  static async uploadPhoto(
    assetId: string,
    user: { id: string; role: string },
    file: Express.Multer.File
  ) {
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset || asset.deletedAt) {
      throw new ApiError(404, "Asset not found");
    }

    const canManage = asset.currentHolderId === user.id || (await canManageAsset(user, asset));
    if (!canManage) {
      throw new ApiError(403, "You are not authorized to upload photos for this asset");
    }

    // Validate image format
    const allowed = ["image/png", "image/jpeg", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      throw new ApiError(400, "Only image files (PNG, JPEG, WebP) are permitted for asset photographs. Invoices cannot be uploaded.");
    }

    // Upload to private bucket
    const fileRef = await StorageService.uploadPrivateFile(file.buffer, file.originalname, file.mimetype);

    const assetFile = await prisma.assetFile.create({
      data: {
        assetId,
        name: file.originalname,
        url: fileRef,
        mimeType: file.mimetype,
        fileSize: file.size,
        uploadedById: user.id
      }
    });

    await prisma.assetEvent.create({
      data: {
        assetId,
        eventType: "UPDATED",
        performedById: user.id,
        title: "Photo Uploaded",
        description: `Uploaded asset photograph: ${file.originalname}`
      }
    });

    const downloadUrl = await StorageService.openUrl(fileRef, file.originalname);
    return {
      ...assetFile,
      downloadUrl
    };
  }

  /**
   * Delete asset photograph.
   */
  static async deletePhoto(fileId: string, user: { id: string; role: string }) {
    const file = await prisma.assetFile.findUnique({
      where: { id: fileId },
      include: { asset: true }
    });

    if (!file) {
      throw new ApiError(404, "Photo not found");
    }

    const canManage = await canManageAsset(user, file.asset);
    if (!canManage) {
      throw new ApiError(403, "You are not authorized to delete photos for this asset");
    }

    await prisma.assetFile.delete({ where: { id: fileId } });
    try {
      await StorageService.deleteFile(file.url);
    } catch {
      // ignore storage purge errors
    }

    await prisma.assetEvent.create({
      data: {
        assetId: file.assetId,
        eventType: "UPDATED",
        performedById: user.id,
        title: "Photo Deleted",
        description: `Deleted asset photograph: ${file.name}`
      }
    });

    return { success: true };
  }

  /**
   * Get all categories.
   */
  static async getCategories() {
    return prisma.assetCategory.findMany({
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: { assets: { where: { deletedAt: null } } }
        }
      }
    });
  }

  /**
   * Add custom category (Admin only).
   */
  static async createCategory(
    user: { id: string; role: string },
    data: { name: string; code: string; description?: string }
  ) {
    if (!isAdmin(user.role)) {
      throw new ApiError(403, "Only Admins can add asset categories");
    }

    const code = data.code.trim().toUpperCase();
    const existing = await prisma.assetCategory.findFirst({
      where: {
        OR: [{ name: { equals: data.name.trim(), mode: "insensitive" } }, { code }]
      }
    });

    if (existing) {
      throw new ApiError(400, "A category with this name or code already exists");
    }

    return prisma.assetCategory.create({
      data: {
        name: data.name.trim(),
        code,
        description: data.description?.trim() || null,
        isCustom: true
      }
    });
  }

  /**
   * Handles asset collection workflow when an employee is suspended or removed.
   */
  static async handleEmployeeExitAssets(employeeId: string): Promise<void> {
    const activeAssignments = await prisma.assetAssignment.findMany({
      where: {
        userId: employeeId,
        isCurrent: true
      },
      include: {
        asset: true,
        user: { select: { fullName: true, reportsToId: true } }
      }
    });

    if (activeAssignments.length === 0) return;

    // Mark assignments as pending collection
    await prisma.assetAssignment.updateMany({
      where: {
        userId: employeeId,
        isCurrent: true
      },
      data: {
        collectionStatus: "PENDING_COLLECTION",
        collectionNotes: "Employee suspended or removed; assets pending physical return/collection."
      }
    });

    for (const assignment of activeAssignments) {
      await prisma.assetEvent.create({
        data: {
          assetId: assignment.assetId,
          eventType: "COLLECTION_REQUESTED",
          title: "Asset Collection Required",
          description: `Employee ${assignment.user.fullName} is no longer active. Asset pending collection.`
        }
      });
    }

    const employeeName = activeAssignments[0]?.user?.fullName || "Employee";
    const managerId = activeAssignments[0]?.user?.reportsToId;

    // Notify reporting manager
    if (managerId) {
      await NotificationService.create({
        userId: managerId,
        assetId: activeAssignments.length === 1 ? activeAssignments[0].assetId : undefined,
        type: "ASSET_COLLECTION_REQUIRED" as any,
        title: "Action Required: Collect Assets",
        message: `${employeeName} is no longer active and has ${activeAssignments.length} asset(s) to collect.`,
        email: true,
        emailLink: "/assets"
      });
    }

    // Notify Admins
    const admins = await prisma.user.findMany({
      where: { role: "ADMIN", deletedAt: null, status: "ACTIVE" },
      select: { id: true }
    });

    for (const adm of admins) {
      if (adm.id !== managerId) {
        await NotificationService.create({
          userId: adm.id,
          assetId: activeAssignments.length === 1 ? activeAssignments[0].assetId : undefined,
          type: "ASSET_COLLECTION_REQUIRED" as any,
          title: "Action Required: Collect Assets",
          message: `${employeeName} is no longer active and has ${activeAssignments.length} asset(s) pending collection.`,
          email: false
        });
      }
    }
  }

  /**
   * Fetch asset-specific notifications for the user.
   */
  static async getAssetNotifications(userId: string) {
    return prisma.notification.findMany({
      where: {
        userId,
        type: {
          in: [
            "ASSET_ASSIGNED",
            "ASSET_RECEIPT_CONFIRMED",
            "ASSET_RECEIPT_PENDING",
            "ASSET_PROBLEM_REPORTED",
            "ASSET_WARRANTY_EXPIRING",
            "ASSET_COLLECTION_REQUIRED",
            "ASSET_RETURNED"
          ] as any
        }
      },
      include: {
        asset: {
          select: { id: true, assetTag: true, name: true, status: true }
        }
      },
      orderBy: { createdAt: "desc" },
      take: 100
    });
  }
}
