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
  // One query walks the whole chain (the old loop made one database trip per person in the team).
  // UNION (not UNION ALL) stops on a loop even if one ever slipped into the data.
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE team AS (
      SELECT "id" FROM "User" WHERE "reportsToId" = ${managerId} AND "deletedAt" IS NULL
      UNION
      SELECT u."id" FROM "User" u JOIN team t ON u."reportsToId" = t."id" WHERE u."deletedAt" IS NULL
    )
    SELECT "id" FROM team WHERE "id" <> ${managerId}`;
  return rows.map((r) => r.id);
}

/**
 * An item nobody holds that isn't in stock (in repair, lost, retired) belongs to the manager who added it,
 * or whose team member last had it. Other managers don't see it (it used to be visible to every manager).
 */
async function isTeamsUnheldAsset(managerId: string, team: string[], asset: { id: string; createdById?: string }) {
  if (asset.createdById === managerId) return true;
  const people = [...team, managerId];
  const had = await prisma.assetAssignment.findFirst({ where: { assetId: asset.id, userId: { in: people } }, select: { id: true } });
  return !!had;
}

/** The same rule as a database filter, for lists (a manager's own team ids include the manager). */
export function managerAssetScope(managerId: string, teamWithSelf: string[]) {
  return [
    { currentHolderId: { in: teamWithSelf } },
    { currentHolderId: null, status: "IN_STOCK" as const },
    { currentHolderId: null, createdById: managerId },
    { currentHolderId: null, assignments: { some: { userId: { in: teamWithSelf } } } }
  ];
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
  const hierarchy = await getReportingHierarchyUserIds(user.id);
  if (asset.currentHolderId) {
    return hierarchy.includes(asset.currentHolderId);
  }

  // 4. Nobody holds it and it isn't in stock: only if it's their team's (see isTeamsUnheldAsset)
  return isTeamsUnheldAsset(user.id, hierarchy, asset);
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

  if (asset.currentHolderId === user.id) return true;
  const hierarchy = await getReportingHierarchyUserIds(user.id);
  if (asset.currentHolderId) {
    return hierarchy.includes(asset.currentHolderId);
  }

  return isTeamsUnheldAsset(user.id, hierarchy, asset as { id: string; createdById?: string });
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

