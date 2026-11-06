-- Sprint 12: Google Chat. A Chat app installed by a customer can read every space it was added to, and one product-wide app serves all
-- customers, so a space must be PROVEN to belong to an organization before it is bound: an admin requests a claim, a person posts
-- the one-time code in the space, and the code (stored encrypted) is then found by reading that space.
CREATE TYPE "ClaimStatus" AS ENUM ('PENDING', 'VERIFIED', 'SUPERSEDED');

CREATE TABLE "SourceClaim" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "provider" "SourceProvider" NOT NULL,
  "externalId" TEXT NOT NULL,
  "teamId" UUID NOT NULL,
  "code" BYTEA NOT NULL,
  "status" "ClaimStatus" NOT NULL DEFAULT 'PENDING',
  "createdByUserId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "verifiedAt" TIMESTAMPTZ(3),
  CONSTRAINT "SourceClaim_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SourceClaim_organizationId_id_key" ON "SourceClaim"("organizationId", "id");
CREATE INDEX "SourceClaim_organizationId_provider_externalId_idx" ON "SourceClaim"("organizationId", "provider", "externalId");
-- One open claim per space per organization; asking again supersedes the old one.
CREATE UNIQUE INDEX "SourceClaim_pending_key" ON "SourceClaim"("organizationId", "provider", "externalId") WHERE "status" = 'PENDING';
ALTER TABLE "SourceClaim" ADD CONSTRAINT "SourceClaim_team_fkey" FOREIGN KEY ("organizationId", "teamId") REFERENCES "Team"("organizationId", "id");
ALTER TABLE "SourceClaim" ADD CONSTRAINT "SourceClaim_verified_has_time" CHECK ("status" <> 'VERIFIED' OR "verifiedAt" IS NOT NULL);

ALTER TABLE "SourceClaim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SourceClaim" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SourceClaim_select" ON "SourceClaim" FOR SELECT USING ("organizationId" = app_org_id());
CREATE POLICY "SourceClaim_insert" ON "SourceClaim" FOR INSERT WITH CHECK ("organizationId" = app_org_id());
CREATE POLICY "SourceClaim_update" ON "SourceClaim" FOR UPDATE USING ("organizationId" = app_org_id()) WITH CHECK ("organizationId" = app_org_id());
GRANT SELECT, INSERT, UPDATE ON "SourceClaim" TO loopsignal_app;

-- Organizations that have an enabled Google Chat space: the Chat poll scan visits these (ids only, like gmail_scan_org_ids()).
CREATE FUNCTION chat_scan_org_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT DISTINCT s."organizationId" FROM "MonitoredSource" s JOIN "SourceConnection" c ON c."organizationId" = s."organizationId" AND c.id = s."connectionId"
    WHERE c.provider = 'GOOGLE_CHAT' AND c.status = 'ACTIVE' AND s.enabled AND s.kind = 'SPACE'
  $$;
REVOKE ALL ON FUNCTION chat_scan_org_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chat_scan_org_ids() TO loopsignal_app;

-- A space may be bound to only ONE organization at a time. Row-level security hides other organizations, so the check needs a narrow
-- cross-tenant read. It also takes a per-space advisory lock that lasts until the caller's transaction ends, so two organizations
-- binding the same space at the same moment cannot both pass the check. Returns a boolean only (never which organization).
CREATE FUNCTION chat_space_bound_elsewhere(space TEXT, org uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
  AS $$
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('chat-space:' || space, 0));
    RETURN EXISTS (
      SELECT 1 FROM "MonitoredSource" s JOIN "SourceConnection" c ON c."organizationId" = s."organizationId" AND c.id = s."connectionId"
      WHERE c.provider = 'GOOGLE_CHAT' AND s.kind = 'SPACE' AND s.enabled AND s."externalId" = space AND s."organizationId" <> org
    );
  END $$;
REVOKE ALL ON FUNCTION chat_space_bound_elsewhere(TEXT, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chat_space_bound_elsewhere(TEXT, uuid) TO loopsignal_app;
