/*
  Warnings:

  - You are about to drop the column `assigneeId` on the `Task` table. All the data in the column will be lost.
  - You are about to drop the column `systemRole` on the `User` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('MANAGER', 'TEAM_MEMBER', 'DEVELOPER', 'DESIGNER', 'TESTER', 'SUPPORT_ENGINEER', 'BUSINESS_ANALYST', 'PROJECT_MANAGER', 'ADMIN');

-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_assigneeId_fkey";

-- DropIndex
DROP INDEX "Task_assigneeId_status_deletedAt_idx";

-- DropIndex
DROP INDEX "User_systemRole_deletedAt_idx";

-- AlterTable
ALTER TABLE "Task" DROP COLUMN "assigneeId";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "systemRole",
ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'TEAM_MEMBER';

-- DropEnum
DROP TYPE "SystemRole";

-- CreateTable
CREATE TABLE "_TaskAssignees" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_TaskAssignees_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_TaskAssignees_B_index" ON "_TaskAssignees"("B");

-- CreateIndex
CREATE INDEX "User_role_deletedAt_idx" ON "User"("role", "deletedAt");

-- AddForeignKey
ALTER TABLE "_TaskAssignees" ADD CONSTRAINT "_TaskAssignees_A_fkey" FOREIGN KEY ("A") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TaskAssignees" ADD CONSTRAINT "_TaskAssignees_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
