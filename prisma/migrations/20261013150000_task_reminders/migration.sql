-- One-off reminder stamps; nullable, so builds that do not know them keep working
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "dueSoonNotifiedAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "overdueNotifiedAt" TIMESTAMP(3);
