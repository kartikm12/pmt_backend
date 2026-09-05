DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserRole') THEN
    CREATE TYPE "UserRole" AS ENUM (
      'MANAGER',
      'TEAM_MEMBER',
      'DEVELOPER',
      'DESIGNER',
      'TESTER',
      'SUPPORT_ENGINEER',
      'BUSINESS_ANALYST',
      'PROJECT_MANAGER',
      'ADMIN'
    );
  END IF;
END $$;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "role" "UserRole";

UPDATE "User"
SET "role" = CASE
  WHEN "systemRole"::text = 'ADMIN' THEN 'MANAGER'::"UserRole"
  ELSE 'TEAM_MEMBER'::"UserRole"
END
WHERE "role" IS NULL;

ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'TEAM_MEMBER';
ALTER TABLE "User" ALTER COLUMN "role" SET NOT NULL;
