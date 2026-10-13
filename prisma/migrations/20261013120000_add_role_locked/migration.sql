-- The code reads User.roleLocked; it was added with `prisma db push` and never got a migration.
-- IF NOT EXISTS keeps this safe on databases that already have the column.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "roleLocked" BOOLEAN NOT NULL DEFAULT true;
