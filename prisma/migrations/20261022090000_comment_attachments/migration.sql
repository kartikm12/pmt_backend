-- Files attached to a specific comment (they also belong to the comment's task). Additive only.
ALTER TABLE "Attachment" ADD COLUMN "commentId" TEXT;

CREATE INDEX "Attachment_commentId_idx" ON "Attachment"("commentId");

ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "TaskComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
