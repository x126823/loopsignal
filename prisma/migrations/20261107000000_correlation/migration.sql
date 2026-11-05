-- Sprint 9: cross-channel correlation. Candidates are decided by people only.
ALTER TABLE "CorrelationCandidate" ADD COLUMN "decidedAt" TIMESTAMPTZ(3);

-- One candidate per (subject, target): replays and re-analysis cannot queue the same question twice.
CREATE UNIQUE INDEX "CorrelationCandidate_organizationId_subjectType_subjectId_targetItemId_key"
  ON "CorrelationCandidate"("organizationId", "subjectType", "subjectId", "targetItemId");

-- A decision always names who made it and when; a pending candidate has neither.
UPDATE "CorrelationCandidate" SET "decidedAt" = "createdAt" WHERE "status" <> 'PENDING' AND "decidedAt" IS NULL;
ALTER TABLE "CorrelationCandidate" ADD CONSTRAINT "CorrelationCandidate_decision_consistent"
  CHECK (("status" = 'PENDING' AND "decidedBy" IS NULL AND "decidedAt" IS NULL) OR ("status" <> 'PENDING' AND "decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL));
