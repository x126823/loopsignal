import { type NextRequest } from "next/server";
import { queueHub } from "@/lib/queue";
import { handleGmailPush } from "@/modules/sources";

export const dynamic = "force-dynamic";

/**
 * Google Pub/Sub push endpoint. It is public by necessity (Google calls it), so the signed token Google attaches is verified
 * before anything else happens; see handleGmailPush. A valid notification only queues a sync. The response never explains why.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown = null;
  try { body = await request.json(); } catch { body = null; }
  const outcome = await handleGmailPush({ authorization: request.headers.get("authorization"), body }, { hub: queueHub() });
  return new Response(null, { status: outcome.status });
}
