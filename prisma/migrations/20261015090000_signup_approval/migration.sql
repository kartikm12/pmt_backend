-- Self sign-ups wait for a manager; existing accounts are unaffected (default false)
ALTER TABLE "User" ADD COLUMN "pendingApproval" BOOLEAN NOT NULL DEFAULT false;
