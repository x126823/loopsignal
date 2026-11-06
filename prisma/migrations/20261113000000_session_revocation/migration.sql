-- Security gap O4: sessions are stateless tokens, so a stolen one used to live until it expired. A person can now end every session of their
-- own ("sign out everywhere"), and an organization administrator can end a member's. A session is valid only if it was issued after the
-- user's `sessionsValidAfter`. Authorization is still resolved from the database on every request, so removing someone from an
-- organization takes effect at once without this; revocation exists to kill a stolen IDENTITY.
ALTER TABLE "User" ADD COLUMN "sessionsValidAfter" TIMESTAMPTZ(3);

-- A person may update their own row (policy user_update). An administrator may not, so the administrator path is a narrow function that
-- re-checks everything: the caller is the signed-in user, an administrator of the organization in the tenant context, and the target is
-- a member of that same organization. It changes one column and nothing else.
CREATE FUNCTION revoke_member_sessions(org uuid, target uuid, at timestamptz) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
  AS $$
  DECLARE n int;
  BEGIN
    IF org IS DISTINCT FROM app_org_id() OR app_user_id() IS NULL THEN RAISE EXCEPTION 'organization does not match the tenant context' USING ERRCODE = '42501'; END IF;
    IF NOT EXISTS (SELECT 1 FROM "Membership" WHERE "organizationId" = org AND "userId" = app_user_id() AND role = 'ORG_ADMIN') THEN RAISE EXCEPTION 'only an organization administrator may do this' USING ERRCODE = '42501'; END IF;
    IF NOT EXISTS (SELECT 1 FROM "Membership" WHERE "organizationId" = org AND "userId" = target) THEN RETURN false; END IF;
    UPDATE "User" SET "sessionsValidAfter" = at WHERE id = target;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n = 1;
  END $$;
REVOKE ALL ON FUNCTION revoke_member_sessions(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_member_sessions(uuid, uuid, timestamptz) TO loopsignal_app;
