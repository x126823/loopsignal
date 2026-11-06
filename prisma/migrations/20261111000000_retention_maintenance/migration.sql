-- Sprint 13: retention, erasure and key rotation.
--
-- RawEvent is append-only for EVERY role (triggers reject UPDATE, DELETE and TRUNCATE, even for the table owner). Retention must delete
-- raw payloads and key rotation must re-encrypt them, so there is exactly one deliberate exception, and it is narrow:
--   * a dedicated NOLOGIN role, loopsignal_maint, owns a few SECURITY DEFINER functions (below);
--   * the RawEvent guard allows a DELETE, or an UPDATE that changes ONLY the encrypted payload, when and only when `current_user` is
--     loopsignal_maint, i.e. inside one of those functions. A direct statement from the app role, from the table owner, or from anyone
--     else still fails, and TRUNCATE and the other append-only tables (LifecycleEvent, AuditLog) are untouched.
--   * each function checks that the organization it is given is the caller's tenant context, so one tenant cannot purge another's rows.
-- The migration role must be able to create roles (a superuser in development and CI).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'loopsignal_maint') THEN
    CREATE ROLE loopsignal_maint NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO loopsignal_maint;
GRANT SELECT ON "RawEvent", "Message", "TrackedItem", "ItemMessageLink" TO loopsignal_maint;
GRANT DELETE ON "RawEvent" TO loopsignal_maint;
GRANT UPDATE ("payload") ON "RawEvent" TO loopsignal_maint;
GRANT UPDATE ("rawEventId") ON "Message" TO loopsignal_maint;
-- Row-level security still applies to the maintenance role: it may only touch the organization in app.org_id.
CREATE POLICY "RawEvent_maint_delete" ON "RawEvent" FOR DELETE TO loopsignal_maint USING ("organizationId" = app_org_id());
CREATE POLICY "RawEvent_maint_update" ON "RawEvent" FOR UPDATE TO loopsignal_maint USING ("organizationId" = app_org_id()) WITH CHECK ("organizationId" = app_org_id());

-- The guard: append-only for everyone except the maintenance role acting inside the functions below.
CREATE FUNCTION raw_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'loopsignal_maint' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'payload') = (to_jsonb(OLD) - 'payload') THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END $$;
DROP TRIGGER "RawEvent_append_only" ON "RawEvent";
CREATE TRIGGER "RawEvent_append_only" BEFORE UPDATE OR DELETE ON "RawEvent" FOR EACH ROW EXECUTE FUNCTION raw_event_guard();

ALTER TABLE "Message" ADD COLUMN "contentPurgedAt" TIMESTAMPTZ(3);
CREATE INDEX "Message_organizationId_contentPurgedAt_idx" ON "Message"("organizationId", "contentPurgedAt");

-- Which messages' content may be removed by age. Runs with the caller's rights (so row-level security scopes it to the tenant).
-- The rule (decided with the user): never while any item the message belongs to is still open; otherwise `cutoff` after the item
-- closed, or after the message arrived when it belongs to no item. A message belongs to an item through the item's thread or an
-- attached conversation (ItemMessageLink).
CREATE FUNCTION retention_expired_message_ids(org uuid, cutoff timestamptz, max_rows int) RETURNS SETOF uuid
  LANGUAGE sql STABLE SET search_path = public
  AS $$
    SELECT m.id FROM "Message" m
    WHERE m."organizationId" = org AND m."contentPurgedAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "TrackedItem" i
        WHERE i."organizationId" = m."organizationId" AND i.state <> 'CLOSED'
          AND (i."threadId" = m."threadId" OR EXISTS (SELECT 1 FROM "ItemMessageLink" l WHERE l."itemId" = i.id AND l."messageId" = m.id)))
      AND coalesce(
            (SELECT max(i."closedAt") FROM "TrackedItem" i
             WHERE i."organizationId" = m."organizationId" AND (i."threadId" = m."threadId" OR EXISTS (SELECT 1 FROM "ItemMessageLink" l WHERE l."itemId" = i.id AND l."messageId" = m.id))),
            m."createdAt") < cutoff
    ORDER BY m."createdAt" LIMIT max_rows
  $$;
GRANT EXECUTE ON FUNCTION retention_expired_message_ids(uuid, timestamptz, int) TO loopsignal_app;

-- Delete raw payloads older than `cutoff` (never those of a message in an open item). Detaches the messages first (Message.rawEventId).
CREATE FUNCTION retention_purge_raw_events(org uuid, cutoff timestamptz, max_rows int) RETURNS int
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
  AS $$
  DECLARE ids uuid[]; n int;
  BEGIN
    IF org IS DISTINCT FROM app_org_id() THEN RAISE EXCEPTION 'organization does not match the tenant context' USING ERRCODE = '42501'; END IF;
    SELECT coalesce(array_agg(x.id), '{}') INTO ids FROM (
      SELECT r.id FROM "RawEvent" r
      WHERE r."organizationId" = org AND r."receivedAt" < cutoff
        AND NOT EXISTS (
          SELECT 1 FROM "Message" m JOIN "TrackedItem" i ON i."organizationId" = m."organizationId" AND i.state <> 'CLOSED'
            AND (i."threadId" = m."threadId" OR EXISTS (SELECT 1 FROM "ItemMessageLink" l WHERE l."itemId" = i.id AND l."messageId" = m.id))
          WHERE m."organizationId" = org AND m."rawEventId" = r.id)
      ORDER BY r."receivedAt" LIMIT max_rows) x;
    UPDATE "Message" SET "rawEventId" = NULL WHERE "organizationId" = org AND "rawEventId" = ANY(ids);
    DELETE FROM "RawEvent" WHERE "organizationId" = org AND id = ANY(ids);
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
  END $$;

-- Delete the raw payloads behind specific messages (an erasure request), whatever their age or item state.
CREATE FUNCTION retention_purge_raw_events_for_messages(org uuid, message_ids uuid[]) RETURNS int
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
  AS $$
  DECLARE ids uuid[]; n int;
  BEGIN
    IF org IS DISTINCT FROM app_org_id() THEN RAISE EXCEPTION 'organization does not match the tenant context' USING ERRCODE = '42501'; END IF;
    SELECT coalesce(array_agg(DISTINCT m."rawEventId"), '{}') INTO ids FROM "Message" m WHERE m."organizationId" = org AND m.id = ANY(message_ids) AND m."rawEventId" IS NOT NULL;
    UPDATE "Message" SET "rawEventId" = NULL WHERE "organizationId" = org AND "rawEventId" = ANY(ids);
    DELETE FROM "RawEvent" WHERE "organizationId" = org AND id = ANY(ids);
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
  END $$;

-- Replace an encrypted payload with the same content under another key (key rotation). Nothing but the payload may change.
CREATE FUNCTION retention_rekey_raw_event(org uuid, raw_event_id uuid, new_payload bytea) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
  AS $$
  DECLARE n int;
  BEGIN
    IF org IS DISTINCT FROM app_org_id() THEN RAISE EXCEPTION 'organization does not match the tenant context' USING ERRCODE = '42501'; END IF;
    UPDATE "RawEvent" SET payload = new_payload WHERE "organizationId" = org AND id = raw_event_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n = 1;
  END $$;

ALTER FUNCTION retention_purge_raw_events(uuid, timestamptz, int) OWNER TO loopsignal_maint;
ALTER FUNCTION retention_purge_raw_events_for_messages(uuid, uuid[]) OWNER TO loopsignal_maint;
ALTER FUNCTION retention_rekey_raw_event(uuid, uuid, bytea) OWNER TO loopsignal_maint;
REVOKE ALL ON FUNCTION retention_purge_raw_events(uuid, timestamptz, int), retention_purge_raw_events_for_messages(uuid, uuid[]), retention_rekey_raw_event(uuid, uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retention_purge_raw_events(uuid, timestamptz, int), retention_purge_raw_events_for_messages(uuid, uuid[]), retention_rekey_raw_event(uuid, uuid, bytea) TO loopsignal_app;

-- Every organization, for the maintenance jobs (retention, audit-chain verification). Ids only, like the other scan functions.
CREATE FUNCTION maintenance_org_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT id FROM "Organization" $$;
REVOKE ALL ON FUNCTION maintenance_org_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance_org_ids() TO loopsignal_app;
