-- Sprint 13 follow-up (security gap O3): the first organization to ask for a Chat space keeps its place.
--
-- A guest who belongs to someone else's space, and administers their own LoopSignal organization, could request a code and post it
-- before the space's real owner has bound it. Requesting a code BEFORE adding the Chat app is now the way to reserve a space: while another
-- organization's earlier claim on the same space is still open (pending and not expired), a later organization's proof is refused.
-- Row-level security hides other organizations, so this is a narrow cross-tenant read: it returns a boolean only, never who or when.
-- It narrows the window; it cannot replace verifying that the space's owner approved the binding, which needs a real domain.
CREATE FUNCTION chat_space_claimed_earlier(space TEXT, org uuid, claim_created timestamptz, at timestamptz) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM "SourceClaim" c
      WHERE c.provider = 'GOOGLE_CHAT' AND c."externalId" = space AND c."organizationId" <> org
        AND c.status = 'PENDING' AND c."expiresAt" > at AND c."createdAt" < claim_created)
  $$;
REVOKE ALL ON FUNCTION chat_space_claimed_earlier(TEXT, uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chat_space_claimed_earlier(TEXT, uuid, timestamptz, timestamptz) TO loopsignal_app;
