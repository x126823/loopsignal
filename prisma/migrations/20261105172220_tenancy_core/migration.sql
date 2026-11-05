-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ORG_ADMIN', 'TEAM_LEAD', 'MEMBER', 'VIEWER', 'AUDITOR');

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_organizationId_userId_key" ON "Membership"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_organizationId_name_key" ON "Team"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Team_organizationId_id_key" ON "Team"("organizationId", "id");

-- CreateIndex
CREATE INDEX "TeamMember_organizationId_userId_idx" ON "TeamMember"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_teamId_userId_key" ON "TeamMember"("teamId", "userId");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_organizationId_teamId_fkey" FOREIGN KEY ("organizationId", "teamId") REFERENCES "Team"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row Level Security (defense in depth behind the Prisma tenant-scope extension)
--
-- The app sets three transaction-local settings (set_config(..., true)):
--   app.org_id      active organization (tenant context)
--   app.user_id     authenticated user (own-row access, membership lookup, org switcher)
--   app.login_email email being authenticated (sign-in lookup only)
-- If a setting is unset or empty the helper returns NULL, every predicate evaluates
-- to NULL, and access fails closed.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION app_login_email() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.login_email', true), '') $$;

ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Organization" FORCE ROW LEVEL SECURITY;
ALTER TABLE "User"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "Membership"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Membership"   FORCE ROW LEVEL SECURITY;
ALTER TABLE "Team"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Team"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "TeamMember"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeamMember"   FORCE ROW LEVEL SECURITY;

-- Organization: the active org, or any org the current user belongs to (org switcher).
CREATE POLICY org_select ON "Organization" FOR SELECT USING (
  id = app_org_id()
  OR EXISTS (SELECT 1 FROM "Membership" m WHERE m."organizationId" = "Organization".id AND m."userId" = app_user_id())
);
CREATE POLICY org_insert ON "Organization" FOR INSERT WITH CHECK (id = app_org_id());
CREATE POLICY org_update ON "Organization" FOR UPDATE USING (id = app_org_id()) WITH CHECK (id = app_org_id());

-- User (global identity): self, the email being signed in, or a member of the active org.
CREATE POLICY user_select ON "User" FOR SELECT USING (
  id = app_user_id()
  OR email = app_login_email()
  OR EXISTS (SELECT 1 FROM "Membership" m WHERE m."userId" = "User".id AND m."organizationId" = app_org_id())
);
CREATE POLICY user_insert ON "User" FOR INSERT WITH CHECK (id = app_user_id());
CREATE POLICY user_update ON "User" FOR UPDATE USING (id = app_user_id()) WITH CHECK (id = app_user_id());

-- Membership: org-scoped; a user may also read their own memberships without an org context.
CREATE POLICY membership_select ON "Membership" FOR SELECT USING (
  "organizationId" = app_org_id() OR "userId" = app_user_id()
);
CREATE POLICY membership_insert ON "Membership" FOR INSERT WITH CHECK ("organizationId" = app_org_id());
CREATE POLICY membership_update ON "Membership" FOR UPDATE
  USING ("organizationId" = app_org_id()) WITH CHECK ("organizationId" = app_org_id());
CREATE POLICY membership_delete ON "Membership" FOR DELETE USING ("organizationId" = app_org_id());

-- Team and TeamMember: strictly org-scoped.
CREATE POLICY team_select ON "Team" FOR SELECT USING ("organizationId" = app_org_id());
CREATE POLICY team_insert ON "Team" FOR INSERT WITH CHECK ("organizationId" = app_org_id());
CREATE POLICY team_update ON "Team" FOR UPDATE
  USING ("organizationId" = app_org_id()) WITH CHECK ("organizationId" = app_org_id());
CREATE POLICY team_delete ON "Team" FOR DELETE USING ("organizationId" = app_org_id());

CREATE POLICY team_member_select ON "TeamMember" FOR SELECT USING ("organizationId" = app_org_id());
CREATE POLICY team_member_insert ON "TeamMember" FOR INSERT WITH CHECK ("organizationId" = app_org_id());
CREATE POLICY team_member_update ON "TeamMember" FOR UPDATE
  USING ("organizationId" = app_org_id()) WITH CHECK ("organizationId" = app_org_id());
CREATE POLICY team_member_delete ON "TeamMember" FOR DELETE USING ("organizationId" = app_org_id());

-- Least-privilege grants for the runtime role (created outside migrations; see docker/postgres/init).
GRANT USAGE ON SCHEMA public TO loopsignal_app;
GRANT SELECT, INSERT, UPDATE         ON "Organization" TO loopsignal_app;
GRANT SELECT, INSERT, UPDATE         ON "User"         TO loopsignal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Membership"   TO loopsignal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Team"         TO loopsignal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "TeamMember"   TO loopsignal_app;
