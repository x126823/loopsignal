-- CreateEnum
CREATE TYPE "SourceProvider" AS ENUM ('GMAIL', 'GOOGLE_CHAT', 'SYNTHETIC');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "MonitoredSourceKind" AS ENUM ('MAILBOX', 'LABEL', 'SPACE');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND', 'INTERNAL');

-- CreateEnum
CREATE TYPE "ItemState" AS ENUM ('RECEIVED', 'ACKNOWLEDGED', 'RESPONDED', 'IN_PROGRESS', 'RESOLUTION_PROPOSED', 'RESOLUTION_CONFIRMED', 'CLOSED', 'REOPENED');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "MessageLinkRole" AS ENUM ('ORIGIN', 'ACK', 'RESPONSE', 'PROGRESS', 'RESOLUTION', 'OTHER');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'ANALYZER');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReviewType" AS ENUM ('LOW_CONFIDENCE', 'CORRELATION', 'SCHEMA_FAILURE', 'OWNERSHIP');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('OK', 'SCHEMA_FAILED', 'REJECTED_GUARD');

-- CreateEnum
CREATE TYPE "SlaTimerType" AS ENUM ('ACK', 'RESPONSE', 'RESOLVE', 'CLOSE');

-- CreateEnum
CREATE TYPE "SlaTimerState" AS ENUM ('RUNNING', 'MET', 'WARNED', 'BREACHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateTable
CREATE TABLE "SourceConnection" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "provider" "SourceProvider" NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "encryptedCredentialRef" TEXT,
    "scopes" TEXT[],
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitoredSource" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "kind" "MonitoredSourceKind" NOT NULL,
    "externalId" TEXT NOT NULL,
    "teamId" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitoredSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "provider" "SourceProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "payload" BYTEA NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Thread" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "provider" "SourceProvider" NOT NULL,
    "externalThreadId" TEXT NOT NULL,
    "canonicalKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Participant" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "displayName" TEXT,
    "userId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "monitoredSourceId" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "provider" "SourceProvider" NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "senderParticipantId" UUID,
    "rawEventId" UUID,
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "subject" TEXT,
    "bodyText" BYTEA NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackedItem" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "ownerUserId" UUID,
    "originMessageId" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "state" "ItemState" NOT NULL DEFAULT 'RECEIVED',
    "slaPolicyId" UUID,
    "ackAt" TIMESTAMPTZ(3),
    "firstSubstantiveResponseAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackedItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemMessageLink" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "role" "MessageLinkRole" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemMessageLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LifecycleEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "fromState" "ItemState",
    "toState" "ItemState" NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "analysisRunId" UUID,
    "evidence" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LifecycleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemOwnership" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "assignedBy" UUID,
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ItemOwnership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "requestedTransition" "ItemState" NOT NULL,
    "requestedBy" UUID,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedBy" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorrelationCandidate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "targetItemId" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "rationale" JSONB NOT NULL,
    "status" "CandidateStatus" NOT NULL DEFAULT 'PENDING',
    "decidedBy" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorrelationCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewTask" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "type" "ReviewType" NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" UUID NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'OPEN',
    "assignedTo" UUID,
    "resolution" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisRun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "analyzer" TEXT NOT NULL,
    "itemId" UUID,
    "messageId" UUID,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION,
    "evidence" JSONB NOT NULL,
    "recommendedAction" TEXT,
    "requiresHumanApproval" BOOLEAN NOT NULL DEFAULT true,
    "status" "AnalysisStatus" NOT NULL,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessCalendar" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "timezone" TEXT NOT NULL,
    "hours" JSONB NOT NULL,
    "holidays" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessCalendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlaPolicy" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "teamId" UUID,
    "monitoredSourceId" UUID,
    "priority" "Priority",
    "ackTargetSec" INTEGER NOT NULL,
    "responseTargetSec" INTEGER NOT NULL,
    "resolveTargetSec" INTEGER NOT NULL,
    "closeTargetSec" INTEGER NOT NULL,
    "calendarId" UUID,
    "warnAtPct" INTEGER NOT NULL DEFAULT 80,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlaPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlaTimer" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "type" "SlaTimerType" NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "state" "SlaTimerState" NOT NULL DEFAULT 'RUNNING',
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "SlaTimer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlaBreach" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "timerId" UUID NOT NULL,
    "breachedAt" TIMESTAMPTZ(3) NOT NULL,
    "acknowledgedBy" UUID,

    CONSTRAINT "SlaBreach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "recipientUserId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "seq" BIGINT NOT NULL DEFAULT 0,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "prevHash" TEXT,
    "hash" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricSnapshot" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "teamId" UUID,
    "period" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SourceConnection_organizationId_provider_idx" ON "SourceConnection"("organizationId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "SourceConnection_organizationId_id_key" ON "SourceConnection"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MonitoredSource_organizationId_id_key" ON "MonitoredSource"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MonitoredSource_organizationId_connectionId_kind_externalId_key" ON "MonitoredSource"("organizationId", "connectionId", "kind", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "RawEvent_organizationId_id_key" ON "RawEvent"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RawEvent_organizationId_provider_externalId_key" ON "RawEvent"("organizationId", "provider", "externalId");

-- CreateIndex
CREATE INDEX "Thread_organizationId_canonicalKey_idx" ON "Thread"("organizationId", "canonicalKey");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_organizationId_id_key" ON "Thread"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_organizationId_provider_externalThreadId_key" ON "Thread"("organizationId", "provider", "externalThreadId");

-- CreateIndex
CREATE UNIQUE INDEX "Participant_organizationId_id_key" ON "Participant"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Participant_organizationId_address_key" ON "Participant"("organizationId", "address");

-- CreateIndex
CREATE INDEX "Message_organizationId_threadId_sentAt_idx" ON "Message"("organizationId", "threadId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_organizationId_id_key" ON "Message"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Message_organizationId_provider_externalMessageId_key" ON "Message"("organizationId", "provider", "externalMessageId");

-- CreateIndex
CREATE INDEX "TrackedItem_organizationId_state_ownerUserId_idx" ON "TrackedItem"("organizationId", "state", "ownerUserId");

-- CreateIndex
CREATE INDEX "TrackedItem_organizationId_teamId_state_idx" ON "TrackedItem"("organizationId", "teamId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedItem_organizationId_id_key" ON "TrackedItem"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ItemMessageLink_organizationId_messageId_idx" ON "ItemMessageLink"("organizationId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemMessageLink_itemId_messageId_key" ON "ItemMessageLink"("itemId", "messageId");

-- CreateIndex
CREATE INDEX "LifecycleEvent_organizationId_itemId_createdAt_idx" ON "LifecycleEvent"("organizationId", "itemId", "createdAt");

-- CreateIndex
CREATE INDEX "ItemOwnership_organizationId_itemId_idx" ON "ItemOwnership"("organizationId", "itemId");

-- CreateIndex
CREATE INDEX "ItemOwnership_organizationId_userId_idx" ON "ItemOwnership"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_organizationId_status_idx" ON "ApprovalRequest"("organizationId", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_organizationId_itemId_idx" ON "ApprovalRequest"("organizationId", "itemId");

-- CreateIndex
CREATE INDEX "CorrelationCandidate_organizationId_status_idx" ON "CorrelationCandidate"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CorrelationCandidate_organizationId_targetItemId_idx" ON "CorrelationCandidate"("organizationId", "targetItemId");

-- CreateIndex
CREATE INDEX "ReviewTask_organizationId_status_type_idx" ON "ReviewTask"("organizationId", "status", "type");

-- CreateIndex
CREATE INDEX "ReviewTask_organizationId_refType_refId_idx" ON "ReviewTask"("organizationId", "refType", "refId");

-- CreateIndex
CREATE INDEX "AnalysisRun_organizationId_itemId_idx" ON "AnalysisRun"("organizationId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisRun_organizationId_id_key" ON "AnalysisRun"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisRun_organizationId_analyzer_inputHash_promptVersion_key" ON "AnalysisRun"("organizationId", "analyzer", "inputHash", "promptVersion");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessCalendar_organizationId_id_key" ON "BusinessCalendar"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SlaPolicy_organizationId_id_key" ON "SlaPolicy"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SlaPolicy_organizationId_name_key" ON "SlaPolicy"("organizationId", "name");

-- CreateIndex
CREATE INDEX "SlaTimer_organizationId_state_dueAt_idx" ON "SlaTimer"("organizationId", "state", "dueAt");

-- CreateIndex
CREATE INDEX "SlaTimer_organizationId_itemId_idx" ON "SlaTimer"("organizationId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "SlaTimer_organizationId_id_key" ON "SlaTimer"("organizationId", "id");

-- CreateIndex
CREATE INDEX "SlaBreach_organizationId_timerId_idx" ON "SlaBreach"("organizationId", "timerId");

-- CreateIndex
CREATE INDEX "Notification_organizationId_recipientUserId_readAt_idx" ON "Notification"("organizationId", "recipientUserId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_organizationId_userId_type_channel_key" ON "NotificationPreference"("organizationId", "userId", "type", "channel");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_entityType_entityId_idx" ON "AuditLog"("organizationId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_organizationId_seq_key" ON "AuditLog"("organizationId", "seq");

-- CreateIndex
CREATE INDEX "MetricSnapshot_organizationId_teamId_period_idx" ON "MetricSnapshot"("organizationId", "teamId", "period");

-- AddForeignKey
ALTER TABLE "MonitoredSource" ADD CONSTRAINT "MonitoredSource_organizationId_connectionId_fkey" FOREIGN KEY ("organizationId", "connectionId") REFERENCES "SourceConnection"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_organizationId_monitoredSourceId_fkey" FOREIGN KEY ("organizationId", "monitoredSourceId") REFERENCES "MonitoredSource"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_organizationId_threadId_fkey" FOREIGN KEY ("organizationId", "threadId") REFERENCES "Thread"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedItem" ADD CONSTRAINT "TrackedItem_organizationId_teamId_fkey" FOREIGN KEY ("organizationId", "teamId") REFERENCES "Team"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedItem" ADD CONSTRAINT "TrackedItem_organizationId_threadId_fkey" FOREIGN KEY ("organizationId", "threadId") REFERENCES "Thread"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedItem" ADD CONSTRAINT "TrackedItem_organizationId_originMessageId_fkey" FOREIGN KEY ("organizationId", "originMessageId") REFERENCES "Message"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemMessageLink" ADD CONSTRAINT "ItemMessageLink_organizationId_itemId_fkey" FOREIGN KEY ("organizationId", "itemId") REFERENCES "TrackedItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemMessageLink" ADD CONSTRAINT "ItemMessageLink_organizationId_messageId_fkey" FOREIGN KEY ("organizationId", "messageId") REFERENCES "Message"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifecycleEvent" ADD CONSTRAINT "LifecycleEvent_organizationId_itemId_fkey" FOREIGN KEY ("organizationId", "itemId") REFERENCES "TrackedItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemOwnership" ADD CONSTRAINT "ItemOwnership_organizationId_itemId_fkey" FOREIGN KEY ("organizationId", "itemId") REFERENCES "TrackedItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_organizationId_itemId_fkey" FOREIGN KEY ("organizationId", "itemId") REFERENCES "TrackedItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrelationCandidate" ADD CONSTRAINT "CorrelationCandidate_organizationId_targetItemId_fkey" FOREIGN KEY ("organizationId", "targetItemId") REFERENCES "TrackedItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlaTimer" ADD CONSTRAINT "SlaTimer_organizationId_itemId_fkey" FOREIGN KEY ("organizationId", "itemId") REFERENCES "TrackedItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlaBreach" ADD CONSTRAINT "SlaBreach_organizationId_timerId_fkey" FOREIGN KEY ("organizationId", "timerId") REFERENCES "SlaTimer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written SQL: everything Prisma cannot express.
-- ===========================================================================

-- ---- Organization FK on every tenant table --------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'SourceConnection','MonitoredSource','RawEvent','Thread','Participant','Message','TrackedItem',
    'ItemMessageLink','LifecycleEvent','ItemOwnership','ApprovalRequest','CorrelationCandidate','ReviewTask',
    'AnalysisRun','BusinessCalendar','SlaPolicy','SlaTimer','SlaBreach','Notification',
    'NotificationPreference','AuditLog','MetricSnapshot'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT',
                   t, t || '_organizationId_fkey');
  END LOOP;
END $$;

-- ---- Optional same-tenant FKs (composite; NULL half skips the check) -------
ALTER TABLE "MonitoredSource" ADD CONSTRAINT "MonitoredSource_team_fkey"
  FOREIGN KEY ("organizationId", "teamId") REFERENCES "Team"("organizationId", "id");
ALTER TABLE "Message" ADD CONSTRAINT "Message_sender_fkey"
  FOREIGN KEY ("organizationId", "senderParticipantId") REFERENCES "Participant"("organizationId", "id");
ALTER TABLE "Message" ADD CONSTRAINT "Message_rawEvent_fkey"
  FOREIGN KEY ("organizationId", "rawEventId") REFERENCES "RawEvent"("organizationId", "id");
ALTER TABLE "TrackedItem" ADD CONSTRAINT "TrackedItem_slaPolicy_fkey"
  FOREIGN KEY ("organizationId", "slaPolicyId") REFERENCES "SlaPolicy"("organizationId", "id");
ALTER TABLE "LifecycleEvent" ADD CONSTRAINT "LifecycleEvent_analysisRun_fkey"
  FOREIGN KEY ("organizationId", "analysisRunId") REFERENCES "AnalysisRun"("organizationId", "id");
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_item_fkey"
  FOREIGN KEY ("organizationId", "itemId") REFERENCES "TrackedItem"("organizationId", "id");
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_message_fkey"
  FOREIGN KEY ("organizationId", "messageId") REFERENCES "Message"("organizationId", "id");
ALTER TABLE "SlaPolicy" ADD CONSTRAINT "SlaPolicy_calendar_fkey"
  FOREIGN KEY ("organizationId", "calendarId") REFERENCES "BusinessCalendar"("organizationId", "id");
ALTER TABLE "SlaPolicy" ADD CONSTRAINT "SlaPolicy_team_fkey"
  FOREIGN KEY ("organizationId", "teamId") REFERENCES "Team"("organizationId", "id");
ALTER TABLE "SlaPolicy" ADD CONSTRAINT "SlaPolicy_source_fkey"
  FOREIGN KEY ("organizationId", "monitoredSourceId") REFERENCES "MonitoredSource"("organizationId", "id");
ALTER TABLE "MetricSnapshot" ADD CONSTRAINT "MetricSnapshot_team_fkey"
  FOREIGN KEY ("organizationId", "teamId") REFERENCES "Team"("organizationId", "id");

-- ---- User references (global table, plain FKs) ------------------------------
ALTER TABLE "SourceConnection"        ADD CONSTRAINT "SourceConnection_owner_fkey"      FOREIGN KEY ("ownerUserId")      REFERENCES "User"("id");
ALTER TABLE "Participant"             ADD CONSTRAINT "Participant_user_fkey"            FOREIGN KEY ("userId")           REFERENCES "User"("id");
ALTER TABLE "TrackedItem"             ADD CONSTRAINT "TrackedItem_owner_fkey"           FOREIGN KEY ("ownerUserId")      REFERENCES "User"("id");
ALTER TABLE "ItemOwnership"           ADD CONSTRAINT "ItemOwnership_user_fkey"          FOREIGN KEY ("userId")           REFERENCES "User"("id");
ALTER TABLE "ItemOwnership"           ADD CONSTRAINT "ItemOwnership_assignedBy_fkey"    FOREIGN KEY ("assignedBy")       REFERENCES "User"("id");
ALTER TABLE "ApprovalRequest"         ADD CONSTRAINT "ApprovalRequest_requestedBy_fkey" FOREIGN KEY ("requestedBy")      REFERENCES "User"("id");
ALTER TABLE "ApprovalRequest"         ADD CONSTRAINT "ApprovalRequest_decidedBy_fkey"   FOREIGN KEY ("decidedBy")        REFERENCES "User"("id");
ALTER TABLE "CorrelationCandidate"    ADD CONSTRAINT "CorrelationCandidate_decidedBy_fkey" FOREIGN KEY ("decidedBy")     REFERENCES "User"("id");
ALTER TABLE "ReviewTask"              ADD CONSTRAINT "ReviewTask_assignedTo_fkey"       FOREIGN KEY ("assignedTo")       REFERENCES "User"("id");
ALTER TABLE "SlaBreach"               ADD CONSTRAINT "SlaBreach_acknowledgedBy_fkey"    FOREIGN KEY ("acknowledgedBy")   REFERENCES "User"("id");
ALTER TABLE "Notification"            ADD CONSTRAINT "Notification_recipient_fkey"      FOREIGN KEY ("recipientUserId")  REFERENCES "User"("id");
ALTER TABLE "NotificationPreference"  ADD CONSTRAINT "NotificationPreference_user_fkey" FOREIGN KEY ("userId")           REFERENCES "User"("id");

-- ---- Integrity constraints --------------------------------------------------
-- One open TrackedItem per (organization, thread); a CLOSED item frees the thread.
CREATE UNIQUE INDEX "TrackedItem_one_open_per_thread"
  ON "TrackedItem" ("organizationId", "threadId") WHERE "state" <> 'CLOSED';
ALTER TABLE "TrackedItem"    ADD CONSTRAINT "TrackedItem_counters_nonneg" CHECK ("reopenCount" >= 0 AND "version" >= 0);
ALTER TABLE "LifecycleEvent" ADD CONSTRAINT "LifecycleEvent_cycle_positive" CHECK ("cycle" >= 1);
ALTER TABLE "AnalysisRun"    ADD CONSTRAINT "AnalysisRun_confidence_range" CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));
ALTER TABLE "CorrelationCandidate" ADD CONSTRAINT "CorrelationCandidate_score_range" CHECK ("score" >= 0 AND "score" <= 1);
ALTER TABLE "SlaPolicy"      ADD CONSTRAINT "SlaPolicy_warn_range" CHECK ("warnAtPct" BETWEEN 1 AND 100);

-- ---- Append-only tables -----------------------------------------------------
-- UPDATE, DELETE and TRUNCATE are rejected for every role, including the owner. (A superuser can still
-- disable triggers or set session_replication_role; that is a deliberate break-glass, not an app path.)
CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['RawEvent','LifecycleEvent','AuditLog'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_mutation()',
                   t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation()',
                   t || '_no_truncate', t);
  END LOOP;
END $$;

-- ---- AuditLog hash chain ----------------------------------------------------
-- Per-organization chain. The trigger takes a per-org advisory lock (serializing concurrent appends),
-- assigns the next seq, links prevHash to the previous row's hash, and computes the row hash.
-- Caller-supplied seq/prevHash/hash are ignored.
CREATE FUNCTION audit_row_hash(r "AuditLog") RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(
    r.seq::text || '|' || coalesce(r."prevHash", '') || '|' || r."organizationId"::text || '|' ||
    r."actorType"::text || '|' || coalesce(r."actorId", '') || '|' || r.action || '|' ||
    r."entityType" || '|' || coalesce(r."entityId", '') || '|' || r.metadata::text || '|' ||
    to_char(r."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    'UTF8')), 'hex')
$$;

CREATE FUNCTION audit_log_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_seq bigint; last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."organizationId"::text, 0));
  SELECT a.seq, a.hash INTO last_seq, last_hash
    FROM "AuditLog" a WHERE a."organizationId" = NEW."organizationId" ORDER BY a.seq DESC LIMIT 1;
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW."prevHash" := last_hash;
  NEW.hash := audit_row_hash(NEW);
  RETURN NEW;
END $$;

CREATE TRIGGER "AuditLog_chain" BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

-- Returns NULL when the organization's chain is intact, otherwise the first bad seq. Needs app.org_id to
-- match the argument, so RLS cannot silently hide rows and report a false "intact".
-- Limit: deleting the newest rows is not detectable without anchoring the head hash externally.
CREATE FUNCTION audit_verify_chain(org uuid) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE r "AuditLog"; prev text := NULL; n bigint := 0;
BEGIN
  IF org IS DISTINCT FROM app_org_id() THEN
    RAISE EXCEPTION 'audit_verify_chain requires app.org_id to equal the organization verified';
  END IF;
  FOR r IN SELECT * FROM "AuditLog" WHERE "organizationId" = org ORDER BY seq LOOP
    n := n + 1;
    IF r.seq <> n OR r."prevHash" IS DISTINCT FROM prev OR r.hash <> audit_row_hash(r) THEN
      RETURN r.seq;
    END IF;
    prev := r.hash;
  END LOOP;
  RETURN NULL;
END $$;

-- ---- Row Level Security on every new tenant table ---------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'SourceConnection','MonitoredSource','RawEvent','Thread','Participant','Message','TrackedItem',
    'ItemMessageLink','LifecycleEvent','ItemOwnership','ApprovalRequest','CorrelationCandidate','ReviewTask',
    'AnalysisRun','BusinessCalendar','SlaPolicy','SlaTimer','SlaBreach','Notification',
    'NotificationPreference','AuditLog','MetricSnapshot'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING ("organizationId" = app_org_id())', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK ("organizationId" = app_org_id())', t || '_insert', t);
    -- Append-only tables get no UPDATE/DELETE policy (and no grant); the triggers are the second wall.
    IF t NOT IN ('RawEvent','LifecycleEvent','AuditLog') THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING ("organizationId" = app_org_id()) WITH CHECK ("organizationId" = app_org_id())', t || '_update', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO loopsignal_app', t);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT ON %I TO loopsignal_app', t);
    END IF;
  END LOOP;
END $$;
