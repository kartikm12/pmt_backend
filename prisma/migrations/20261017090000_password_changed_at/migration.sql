-- When each person last changed their password (shown on Settings -> Password). Additive only.
ALTER TABLE "User" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);

-- Best known date for existing accounts: their latest completed email reset, if any
UPDATE "User" u SET "passwordChangedAt" = t.last
FROM (SELECT "userId", max("usedAt") AS last FROM "PasswordResetToken" WHERE "usedAt" IS NOT NULL GROUP BY "userId") t
WHERE t."userId" = u.id;
