-- Asset management (reporting lines, asset register, hand-overs, history, photos) AND a repair.
-- Every step is harmless if it was already done, so this one file is right for both:
--  * a fresh database (creates everything), and
--  * the live database as found on 15 Nov 2026: someone ran another copy of PMT's schema against it with
--    "db push", which already created the asset tables (and data: kept as is), but also dropped the rules
--    tables, turned BoardColumn.stage into blank text and removed the column links. This puts them back.
-- Run with: npx prisma db execute --file <this file> --schema prisma/schema.prisma
BEGIN;

-- 1. Board columns: each default column's id ends with its stage (col_<project>_IN_PROGRESS), so the
--    blanked stage is restored exactly from it; then the column gets its proper type back. A column whose
--    stage can't be worked out stops the whole change (nothing is guessed, nothing half-done).
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'BoardColumn' AND column_name = 'stage') = 'text' THEN
    UPDATE "BoardColumn" SET "stage" = substring("id" from '_(TODO|IN_PROGRESS|REVIEW|DONE)$') WHERE "stage" IS NULL;
    ALTER TABLE "BoardColumn" ALTER COLUMN "stage" TYPE "TaskStatus" USING "stage"::"TaskStatus";
  END IF;
END $$;
ALTER TABLE "BoardColumn"
  ALTER COLUMN "projectId" SET NOT NULL,
  ALTER COLUMN "name" SET NOT NULL,
  ALTER COLUMN "stage" SET NOT NULL,
  ALTER COLUMN "position" SET NOT NULL,
  ALTER COLUMN "createdAt" SET NOT NULL,
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET NOT NULL,
  ALTER COLUMN "updatedAt" DROP DEFAULT;

-- 2. Rules tables, column indexes and links (as in 20261111090000_board_columns_rules)
CREATE TABLE IF NOT EXISTS "ProjectRule" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" TEXT NOT NULL,
    "triggerValue" TEXT,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectRule_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "RuleRun" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BoardColumn_projectId_position_idx" ON "BoardColumn"("projectId", "position");
CREATE INDEX IF NOT EXISTS "ProjectRule_projectId_trigger_enabled_idx" ON "ProjectRule"("projectId", "trigger", "enabled");
CREATE INDEX IF NOT EXISTS "RuleRun_taskId_idx" ON "RuleRun"("taskId");
CREATE UNIQUE INDEX IF NOT EXISTS "RuleRun_ruleId_taskId_key_key" ON "RuleRun"("ruleId", "taskId", "key");
DO $$ BEGIN ALTER TABLE "Task" ADD CONSTRAINT "Task_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "BoardColumn"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "BoardColumn" ADD CONSTRAINT "BoardColumn_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ProjectRule" ADD CONSTRAINT "ProjectRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "RuleRun" ADD CONSTRAINT "RuleRun_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ProjectRule"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "RuleRun" ADD CONSTRAINT "RuleRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Projects with no columns at all (made by a copy that didn't create them) get the usual four,
--    and any task without a column goes to its stage's column (same as 20261111090000)
INSERT INTO "BoardColumn" ("id", "projectId", "name", "stage", "position", "updatedAt")
SELECT 'col_' || p."id" || '_' || s.stage, p."id", s.name, s.stage::"TaskStatus", s.pos, CURRENT_TIMESTAMP
FROM "Project" p
CROSS JOIN (VALUES ('TODO', 'To Do', 0), ('IN_PROGRESS', 'In Progress', 1), ('REVIEW', 'Review', 2), ('DONE', 'Completed', 3)) AS s(stage, name, pos)
WHERE NOT EXISTS (SELECT 1 FROM "BoardColumn" c WHERE c."projectId" = p."id")
ON CONFLICT ("id") DO NOTHING;
UPDATE "Task" t SET "columnId" = 'col_' || t."projectId" || '_' || t."status"::text
WHERE t."columnId" IS NULL;

-- 4. Asset management
DO $$ BEGIN CREATE TYPE "AssetStatus" AS ENUM ('IN_STOCK', 'ASSIGNED', 'IN_REPAIR', 'LOST', 'RETIRED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "AssetCondition" AS ENUM ('NEW', 'GOOD', 'FAIR', 'DAMAGED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "AssetAssignmentReceiptStatus" AS ENUM ('PENDING', 'CONFIRMED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "AssetAssignmentCollectionStatus" AS ENUM ('NONE', 'PENDING_COLLECTION', 'COLLECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "AssetEventType" AS ENUM ('CREATED', 'UPDATED', 'ASSIGNED', 'RECEIPT_CONFIRMED', 'RETURNED', 'MARKED_FOR_REPAIR', 'REPAIR_COMPLETED', 'MARKED_LOST', 'RETIRED', 'DELETED', 'RESTORED', 'PROBLEM_REPORTED', 'COLLECTION_REQUESTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ASSET_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ASSET_RECEIPT_CONFIRMED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ASSET_RECEIPT_PENDING';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ASSET_PROBLEM_REPORTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ASSET_WARRANTY_EXPIRING';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ASSET_COLLECTION_REQUIRED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ASSET_RETURNED';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "reportsToId" TEXT;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "assetId" TEXT;
CREATE TABLE IF NOT EXISTS "AssetCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetCategory_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "Asset" (
    "id" TEXT NOT NULL,
    "assetTag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "brand" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "specifications" TEXT,
    "condition" "AssetCondition" NOT NULL DEFAULT 'GOOD',
    "status" "AssetStatus" NOT NULL DEFAULT 'IN_STOCK',
    "location" TEXT,
    "purchaseDate" TIMESTAMP(3),
    "purchaseCost" DOUBLE PRECISION,
    "vendorName" TEXT,
    "warrantyStartDate" TIMESTAMP(3),
    "warrantyEndDate" TIMESTAMP(3),
    "warrantyReminderSentAt" TIMESTAMP(3),
    "renewalReminderSentAt" TIMESTAMP(3),
    "currentHolderId" TEXT,
    "projectId" TEXT,
    "createdById" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "AssetAssignment" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "assignedById" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignmentCondition" "AssetCondition" NOT NULL DEFAULT 'GOOD',
    "notes" TEXT,
    "receiptStatus" "AssetAssignmentReceiptStatus" NOT NULL DEFAULT 'PENDING',
    "receiptConfirmedAt" TIMESTAMP(3),
    "receiptReminderSentAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "returnCondition" "AssetCondition",
    "returnRemarks" TEXT,
    "returnDisposition" TEXT,
    "returnedById" TEXT,
    "collectionStatus" "AssetAssignmentCollectionStatus" NOT NULL DEFAULT 'NONE',
    "collectionNotes" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetAssignment_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "AssetEvent" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "eventType" "AssetEventType" NOT NULL,
    "performedById" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetEvent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "AssetFile" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetFile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssetCategory_name_key" ON "AssetCategory"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "AssetCategory_code_key" ON "AssetCategory"("code");
CREATE INDEX IF NOT EXISTS "AssetCategory_name_idx" ON "AssetCategory"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "Asset_assetTag_key" ON "Asset"("assetTag");
CREATE UNIQUE INDEX IF NOT EXISTS "Asset_serialNumber_key" ON "Asset"("serialNumber");
CREATE INDEX IF NOT EXISTS "Asset_status_deletedAt_idx" ON "Asset"("status", "deletedAt");
CREATE INDEX IF NOT EXISTS "Asset_categoryId_deletedAt_idx" ON "Asset"("categoryId", "deletedAt");
CREATE INDEX IF NOT EXISTS "Asset_currentHolderId_deletedAt_idx" ON "Asset"("currentHolderId", "deletedAt");
CREATE INDEX IF NOT EXISTS "Asset_warrantyEndDate_idx" ON "Asset"("warrantyEndDate");
CREATE INDEX IF NOT EXISTS "Asset_deletedAt_idx" ON "Asset"("deletedAt");
CREATE INDEX IF NOT EXISTS "AssetAssignment_assetId_isCurrent_idx" ON "AssetAssignment"("assetId", "isCurrent");
CREATE INDEX IF NOT EXISTS "AssetAssignment_userId_isCurrent_idx" ON "AssetAssignment"("userId", "isCurrent");
CREATE INDEX IF NOT EXISTS "AssetAssignment_receiptStatus_isCurrent_idx" ON "AssetAssignment"("receiptStatus", "isCurrent");
CREATE INDEX IF NOT EXISTS "AssetAssignment_collectionStatus_idx" ON "AssetAssignment"("collectionStatus");
CREATE INDEX IF NOT EXISTS "AssetEvent_assetId_createdAt_idx" ON "AssetEvent"("assetId", "createdAt");
CREATE INDEX IF NOT EXISTS "AssetEvent_eventType_idx" ON "AssetEvent"("eventType");
CREATE INDEX IF NOT EXISTS "AssetFile_assetId_createdAt_idx" ON "AssetFile"("assetId", "createdAt");
CREATE INDEX IF NOT EXISTS "User_reportsToId_idx" ON "User"("reportsToId");
CREATE INDEX IF NOT EXISTS "Notification_assetId_createdAt_idx" ON "Notification"("assetId", "createdAt");
DO $$ BEGIN ALTER TABLE "User" ADD CONSTRAINT "User_reportsToId_fkey" FOREIGN KEY ("reportsToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Notification" ADD CONSTRAINT "Notification_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Asset" ADD CONSTRAINT "Asset_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "AssetCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Asset" ADD CONSTRAINT "Asset_currentHolderId_fkey" FOREIGN KEY ("currentHolderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Asset" ADD CONSTRAINT "Asset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "Asset" ADD CONSTRAINT "Asset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "AssetAssignment" ADD CONSTRAINT "AssetAssignment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "AssetAssignment" ADD CONSTRAINT "AssetAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "AssetEvent" ADD CONSTRAINT "AssetEvent_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "AssetEvent" ADD CONSTRAINT "AssetEvent_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "AssetFile" ADD CONSTRAINT "AssetFile_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 5. Starting categories (the same 12 as src/scripts/seed-asset-categories.ts); existing ones are left alone
INSERT INTO "AssetCategory" ("id", "name", "code", "description", "isCustom", "updatedAt")
VALUES
  ('cat_lap', 'Laptop', 'LAP', 'Laptops and notebooks', false, CURRENT_TIMESTAMP),
  ('cat_desk', 'Desktop', 'DESK', 'Desktop workstations and towers', false, CURRENT_TIMESTAMP),
  ('cat_mon', 'Monitor', 'MON', 'Display monitors and screens', false, CURRENT_TIMESTAMP),
  ('cat_phn', 'Mobile Phone', 'PHN', 'Company smartphones and phones', false, CURRENT_TIMESTAMP),
  ('cat_tab', 'Tablet', 'TAB', 'iPads and Android tablets', false, CURRENT_TIMESTAMP),
  ('cat_keyb', 'Keyboard', 'KEYB', 'Keyboards', false, CURRENT_TIMESTAMP),
  ('cat_mou', 'Mouse', 'MOU', 'Mice and pointing devices', false, CURRENT_TIMESTAMP),
  ('cat_head', 'Headset', 'HEAD', 'Audio headsets, headphones and earphones', false, CURRENT_TIMESTAMP),
  ('cat_acc', 'Accessories', 'ACC', 'Adapters, cables, docks and accessories', false, CURRENT_TIMESTAMP),
  ('cat_card', 'Access Card', 'CARD', 'Office access cards and NFC badges', false, CURRENT_TIMESTAMP),
  ('cat_lic', 'Software Licence', 'LIC', 'Software licences and subscriptions', false, CURRENT_TIMESTAMP),
  ('cat_oth', 'Other', 'OTH', 'Other company assets', false, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

COMMIT;
