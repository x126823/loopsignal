-- Sprint 11: Gmail connections. OAuth tokens are stored encrypted (application-layer AES-256-GCM) in their own table so that
-- no query that lists connections can return them.
CREATE TABLE "ConnectionCredential" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "tokens" BYTEA NOT NULL,
  "accessTokenExpiresAt" TIMESTAMPTZ(3) NOT NULL,
  "watchExpiresAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ConnectionCredential_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConnectionCredential_organizationId_connectionId_key" ON "ConnectionCredential"("organizationId", "connectionId");
ALTER TABLE "ConnectionCredential" ADD CONSTRAINT "ConnectionCredential_connectionId_fkey"
  FOREIGN KEY ("organizationId", "connectionId") REFERENCES "SourceConnection"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConnectionCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConnectionCredential" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ConnectionCredential_select" ON "ConnectionCredential" FOR SELECT USING ("organizationId" = app_org_id());
CREATE POLICY "ConnectionCredential_insert" ON "ConnectionCredential" FOR INSERT WITH CHECK ("organizationId" = app_org_id());
CREATE POLICY "ConnectionCredential_update" ON "ConnectionCredential" FOR UPDATE USING ("organizationId" = app_org_id()) WITH CHECK ("organizationId" = app_org_id());
-- Disconnecting deletes the credentials (the only way to make revocation final).
CREATE POLICY "ConnectionCredential_delete" ON "ConnectionCredential" FOR DELETE USING ("organizationId" = app_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "ConnectionCredential" TO loopsignal_app;

-- Two deliberate, narrow cross-tenant reads, like sla_scan_org_ids(): background jobs and the push endpoint have no organization
-- yet, and row-level security hides every organization from the app role. Both return ids only (no addresses, no content), and
-- everything done afterwards runs inside that organization's own tenant context.
-- (They run with the owner's rights; the migration role bypasses RLS in development and CI.)

-- Organizations that have an active Gmail connection: the poll/renewal scan visits these.
CREATE FUNCTION gmail_scan_org_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT DISTINCT "organizationId" FROM "SourceConnection" WHERE provider = 'GMAIL' AND status = 'ACTIVE' $$;
REVOKE ALL ON FUNCTION gmail_scan_org_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gmail_scan_org_ids() TO loopsignal_app;

-- Which enabled mailbox sources watch this address: a Pub/Sub notification names only a mailbox, never an organization.
CREATE FUNCTION gmail_mailbox_sources(address TEXT) RETURNS TABLE ("organizationId" uuid, "monitoredSourceId" uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT s."organizationId", s.id FROM "MonitoredSource" s JOIN "SourceConnection" c ON c."organizationId" = s."organizationId" AND c.id = s."connectionId"
    WHERE c.provider = 'GMAIL' AND c.status = 'ACTIVE' AND s.enabled AND s.kind = 'MAILBOX' AND s."externalId" = lower(address)
  $$;
REVOKE ALL ON FUNCTION gmail_mailbox_sources(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gmail_mailbox_sources(TEXT) TO loopsignal_app;
