-- 11 Nov: each project gets its own board columns (each counting as one of the four stages) and rules.
-- Additive only: nothing existing changes shape, so the running app keeps working while this is applied.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "columnId" TEXT;

-- CreateTable
CREATE TABLE "BoardColumn" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stage" "TaskStatus" NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardColumn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectRule" (
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

-- CreateTable
CREATE TABLE "RuleRun" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BoardColumn_projectId_position_idx" ON "BoardColumn"("projectId", "position");

-- CreateIndex
CREATE INDEX "ProjectRule_projectId_trigger_enabled_idx" ON "ProjectRule"("projectId", "trigger", "enabled");

-- CreateIndex
CREATE INDEX "RuleRun_taskId_idx" ON "RuleRun"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "RuleRun_ruleId_taskId_key_key" ON "RuleRun"("ruleId", "taskId", "key");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "BoardColumn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardColumn" ADD CONSTRAINT "BoardColumn_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRule" ADD CONSTRAINT "ProjectRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleRun" ADD CONSTRAINT "RuleRun_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ProjectRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleRun" ADD CONSTRAINT "RuleRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing project gets the four usual columns, and each task goes into the column of its
-- status. Ids are derived from the project id so a re-run can't create duplicates.
INSERT INTO "BoardColumn" ("id", "projectId", "name", "stage", "position", "updatedAt")
SELECT 'col_' || p."id" || '_' || s.stage, p."id", s.name, s.stage::"TaskStatus", s.pos, CURRENT_TIMESTAMP
FROM "Project" p
CROSS JOIN (VALUES ('TODO', 'To Do', 0), ('IN_PROGRESS', 'In Progress', 1), ('REVIEW', 'Review', 2), ('DONE', 'Completed', 3)) AS s(stage, name, pos)
ON CONFLICT ("id") DO NOTHING;

UPDATE "Task" t SET "columnId" = 'col_' || t."projectId" || '_' || t."status"::text
WHERE t."columnId" IS NULL;
