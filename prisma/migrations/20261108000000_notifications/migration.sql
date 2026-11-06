-- Sprint 10: notifications. A replayed job must not notify twice; email is recorded for a later delivery step, never sent here.
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;
ALTER TABLE "Notification" ADD COLUMN "deliveredAt" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "Notification_organizationId_recipientUserId_channel_dedupeKey_key"
  ON "Notification"("organizationId", "recipientUserId", "channel", "dedupeKey");
-- Nothing is delivered by email in this release.
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_email_not_delivered" CHECK ("channel" <> 'EMAIL' OR "deliveredAt" IS NULL);

-- Notifications and preferences are personal. When a request carries a user (the web app always does), row-level security shows
-- and changes only that user's own rows, so app code is not the only thing keeping one person's inbox from another. System
-- contexts (workers creating notifications) carry no user and keep organization-wide access, as before.
DROP POLICY "Notification_select" ON "Notification";
DROP POLICY "Notification_update" ON "Notification";
CREATE POLICY "Notification_select" ON "Notification" FOR SELECT
  USING ("organizationId" = app_org_id() AND (app_user_id() IS NULL OR "recipientUserId" = app_user_id()));
CREATE POLICY "Notification_update" ON "Notification" FOR UPDATE
  USING ("organizationId" = app_org_id() AND (app_user_id() IS NULL OR "recipientUserId" = app_user_id()))
  WITH CHECK ("organizationId" = app_org_id() AND (app_user_id() IS NULL OR "recipientUserId" = app_user_id()));

DROP POLICY "NotificationPreference_select" ON "NotificationPreference";
DROP POLICY "NotificationPreference_update" ON "NotificationPreference";
CREATE POLICY "NotificationPreference_select" ON "NotificationPreference" FOR SELECT
  USING ("organizationId" = app_org_id() AND (app_user_id() IS NULL OR "userId" = app_user_id()));
CREATE POLICY "NotificationPreference_update" ON "NotificationPreference" FOR UPDATE
  USING ("organizationId" = app_org_id() AND (app_user_id() IS NULL OR "userId" = app_user_id()))
  WITH CHECK ("organizationId" = app_org_id() AND (app_user_id() IS NULL OR "userId" = app_user_id()));
