-- Sprint 8: SLA engine support.

-- Timers belong to a lifecycle cycle and carry a fixed warning time.
ALTER TABLE "SlaTimer" ADD COLUMN "cycle" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "SlaTimer" ADD COLUMN "warnAt" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "SlaTimer_itemId_cycle_type_key" ON "SlaTimer"("itemId", "cycle", "type");
ALTER TABLE "SlaTimer" ADD CONSTRAINT "SlaTimer_cycle_positive" CHECK ("cycle" >= 1);

-- One breach row per timer, so detection is idempotent however many workers scan.
CREATE UNIQUE INDEX "SlaBreach_timerId_key" ON "SlaBreach"("timerId");

-- The four obligations are nested: acknowledge <= respond <= resolve <= close, all positive.
ALTER TABLE "SlaPolicy" ADD CONSTRAINT "SlaPolicy_targets_ordered"
  CHECK ("ackTargetSec" > 0 AND "ackTargetSec" <= "responseTargetSec" AND "responseTargetSec" <= "resolveTargetSec" AND "resolveTargetSec" <= "closeTargetSec");

-- The breach scanner is a background job that must visit every organization that has SLA policies, but row-level security
-- hides other organizations from the app role. This is the ONE deliberate cross-tenant read: it returns organization ids only
-- (no names, no content). Everything the scanner then does for an organization runs under that organization's own tenant
-- context, so all further reads and writes stay RLS-scoped.
-- The function runs with its owner's rights; the migration role must therefore bypass RLS (it is a superuser in development
-- and CI), or this returns nothing.
CREATE FUNCTION sla_scan_org_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT DISTINCT "organizationId" FROM "SlaPolicy" $$;
REVOKE ALL ON FUNCTION sla_scan_org_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sla_scan_org_ids() TO loopsignal_app;
