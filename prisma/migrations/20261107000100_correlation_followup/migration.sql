-- When the follow-up work for a decision (create the item after a rejection, catch up replies after a confirmation) was queued.
ALTER TABLE "CorrelationCandidate" ADD COLUMN "followUpAt" TIMESTAMPTZ(3);
UPDATE "CorrelationCandidate" SET "followUpAt" = "decidedAt" WHERE "status" <> 'PENDING';
