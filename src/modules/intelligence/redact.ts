import type { TenantTx } from "@/lib/db";

/**
 * Analysis runs keep the verbatim quotes that justified a recommendation (rule 6), so they hold message text too. When a message's
 * content is removed (retention or an erasure), its quotes must go with it. The run, its decision and its confidence stay: only the
 * quote text is replaced by a marker. Returns how many runs changed. Idempotent.
 */
export const REDACTED_QUOTE = "[removed by retention]";

export async function redactEvidenceForMessages(tx: TenantTx, organizationId: string, messageIds: string[]): Promise<number> {
  if (messageIds.length === 0) return 0;
  return tx.$executeRaw`
    UPDATE "AnalysisRun" r SET evidence = (
      SELECT coalesce(jsonb_agg(CASE WHEN e->>'messageId' = ANY(${messageIds}::text[]) THEN jsonb_set(e, '{quote}', to_jsonb(${REDACTED_QUOTE}::text)) ELSE e END), '[]'::jsonb)
      FROM jsonb_array_elements(r.evidence) e)
    WHERE r."organizationId" = ${organizationId}::uuid AND jsonb_typeof(r.evidence) = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.evidence) e WHERE e->>'messageId' = ANY(${messageIds}::text[]) AND e->>'quote' IS DISTINCT FROM ${REDACTED_QUOTE}::text)`;
}
