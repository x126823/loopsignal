-- Splitting a cross-channel match detaches a thread from an item, which removes link rows. The app role had no DELETE on any
-- tenant table before this; it is granted here on this one table only, because links are not history (LifecycleEvent, AuditLog and RawEvent stay append-only), and the
-- unlink is audited in the same transaction by the correlation module. Row-level security still confines it to one organization.
CREATE POLICY "ItemMessageLink_delete" ON "ItemMessageLink" FOR DELETE USING ("organizationId" = app_org_id());
GRANT DELETE ON "ItemMessageLink" TO loopsignal_app;
