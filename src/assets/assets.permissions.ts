import { prisma } from "../prisma/client.js";
import { USER_ROLE, type UserRole } from "../constants/enums.js";
import { ApiError } from "../utils/apiError.js";

export function isAdmin(role: string): boolean {
  return role === USER_ROLE.ADMIN || role === "ADMIN";
}

export function isManagerRole(role: string): boolean {
  return (
    role === USER_ROLE.ADMIN ||
    role === "ADMIN" ||
    role === USER_ROLE.MANAGER ||
    role === "MANAGER" ||
    role === USER_ROLE.PROJECT_MANAGER ||
    role === "PROJECT_MANAGER"
  );
}

/**
 * Recursively retrieves all direct and indirect report user IDs for a given manager.
 */
export async function getReportingHierarchyUserIds(managerId: string): Promise<string[]> {
  const result = new Set<string>();
  const queue = [managerId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const directReports = await prisma.user.findMany({
      where: {
        reportsToId: currentId,
        deletedAt: null
      },
      select: { id: true }
    });

    for (const report of directReports) {
      if (!result.has(report.id)) {
        result.add(report.id);
        queue.push(report.id);
      }
    }
  }

  return Array.from(result);
}

/**
 * Validates that setting `targetManagerId` as `userId`'s manager does not violate hierarchy rules:
 * 1. A user cannot report to themselves.
 * 2. Circular reporting is prohibited (targetManager cannot be a subordinate of userId).
 */
export async function validateReportsTo(userId: string, targetManagerId: string | null): Promise<void> {
  if (!targetManagerId) return;

  if (userId === targetManagerId) {
    throw new ApiError(400, "An employee cannot report to themselves");
  }

  // Ensure target manager exists and is active
  const targetManager = await prisma.user.findFirst({
    where: { id: targetManagerId, deletedAt: null },
    select: { id: true, status: true }
  });

  if (!targetManager) {
    throw new ApiError(404, "Target manager not found or inactive");
  }

  if (targetManager.status === "SUSPENDED") {
    throw new ApiError(400, "Cannot assign a suspended user as reporting manager");
  }

  // Check if targetManager is in userId's subordinates tree
  const subordinates = await getReportingHierarchyUserIds(userId);
  if (subordinates.includes(targetManagerId)) {
    throw new ApiError(400, "Circular reporting hierarchy detected: target manager is a subordinate of this user");
  }
}

/**
 * Checks if user is permitted to view/manage an asset.
 * If not permitted, caller should throw 404 (or return false) to prevent info leakage.
 */
export async function canAccessAsset(
  user: { id: string; role: string },
  asset: {
    id: string;
    currentHolderId: string | null;
    status: string;
    createdById: string;
  }
): Promise<boolean> {
  if (isAdmin(user.role)) return true;

  // Non-admin employees can only access assets currently assigned to them
  if (!isManagerRole(user.role)) {
    return asset.currentHolderId === user.id;
  }

  // Managers can access:
  // 1. Their own assigned assets
  if (asset.currentHolderId === user.id) return true;

  // 2. Unassigned inventory (IN_STOCK)
  if (asset.status === "IN_STOCK" && !asset.currentHolderId) return true;

  // 3. Assets assigned to anyone in their reporting hierarchy
  if (asset.currentHolderId) {
    const hierarchy = await getReportingHierarchyUserIds(user.id);
    return hierarchy.includes(asset.currentHolderId);
  }

  return true;
}

/**
 * Checks if user is permitted to perform management operations (assign, return, repair) on an asset.
 */
export async function canManageAsset(
  user: { id: string; role: string },
  asset: {
    id: string;
    currentHolderId: string | null;
    status: string;
  }
): Promise<boolean> {
  if (isAdmin(user.role)) return true;
  if (!isManagerRole(user.role)) return false;

  if (asset.status === "IN_STOCK") return true;

  if (asset.currentHolderId) {
    if (asset.currentHolderId === user.id) return true;
    const hierarchy = await getReportingHierarchyUserIds(user.id);
    return hierarchy.includes(asset.currentHolderId);
  }

  return true;
}

/**
 * Redacts sensitive fields (purchaseCost, serialNumber) for regular employees.
 */
export function sanitizeAssetForUser<T extends Record<string, any>>(
  asset: T,
  userRole: string
): T {
  if (isAdmin(userRole) || isManagerRole(userRole)) {
    return asset;
  }

  const sanitized = { ...asset };
  delete sanitized.purchaseCost;
  delete sanitized.serialNumber;
  return sanitized;
}

