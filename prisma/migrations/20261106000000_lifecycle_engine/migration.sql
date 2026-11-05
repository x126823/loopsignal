-- Sprint 3: lifecycle engine support.

-- 1. LifecycleEvent.seq: canonical per-item replay order (timestamps alone tie when one message triggers two steps).
--    The table is append-only, so the one-time backfill of pre-existing rows briefly disables its trigger.
ALTER TABLE "LifecycleEvent" ADD COLUMN "seq" INTEGER;

ALTER TABLE "LifecycleEvent" DISABLE TRIGGER "LifecycleEvent_append_only";
UPDATE "LifecycleEvent" e SET "seq" = r.rn
  FROM (SELECT id, row_number() OVER (PARTITION BY "itemId" ORDER BY "createdAt", id) AS rn FROM "LifecycleEvent") r
  WHERE e.id = r.id;
ALTER TABLE "LifecycleEvent" ENABLE TRIGGER "LifecycleEvent_append_only";

ALTER TABLE "LifecycleEvent" ALTER COLUMN "seq" SET NOT NULL;
ALTER TABLE "LifecycleEvent" ADD CONSTRAINT "LifecycleEvent_seq_positive" CHECK ("seq" >= 1);
CREATE UNIQUE INDEX "LifecycleEvent_itemId_seq_key" ON "LifecycleEvent"("itemId", "seq");

-- 2. Rule 1 guard (defense in depth): TrackedItem rows and their lifecycle columns (state, the four metric
--    timestamps, reopenCount, version) can only be written while the transaction-local flag
--    app.lifecycle_writer is 'on'. Only src/modules/lifecycle sets it (a lint rule bans the string elsewhere).
--    This catches bugs and stray writes; it is not a security boundary, since any code holding the app
--    connection could set the flag in raw SQL.
CREATE FUNCTION trackeditem_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.lifecycle_writer', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'TrackedItem rows are created by the lifecycle engine only' USING ERRCODE = '55000';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state"
     OR NEW."ackAt" IS DISTINCT FROM OLD."ackAt"
     OR NEW."firstSubstantiveResponseAt" IS DISTINCT FROM OLD."firstSubstantiveResponseAt"
     OR NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt"
     OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt"
     OR NEW."reopenCount" IS DISTINCT FROM OLD."reopenCount"
     OR NEW."version" IS DISTINCT FROM OLD."version" THEN
    RAISE EXCEPTION 'TrackedItem lifecycle columns are written by the lifecycle engine only' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "TrackedItem_lifecycle_guard" BEFORE INSERT OR UPDATE ON "TrackedItem"
  FOR EACH ROW EXECUTE FUNCTION trackeditem_lifecycle_guard();
