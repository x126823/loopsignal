-- Sprint 4: per-source sync position for ingestion.
ALTER TABLE "MonitoredSource" ADD COLUMN "cursor" TEXT;
ALTER TABLE "MonitoredSource" ADD COLUMN "lastSyncedAt" TIMESTAMPTZ(3);
