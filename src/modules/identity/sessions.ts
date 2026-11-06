import { withTenant } from "@/lib/db";
import { recordAudit } from "@/modules/audit";
import { assertCan, type Principal } from "./rbac";

/**
 * Ending sessions early. A session is a signed token that says who someone is and when it was issued; it does not say what they may do
 * (that is resolved from the database on every request). Revocation records "sessions issued before T are void" on the user, and the app
 * refuses any session issued before it. A person ends their own with "Sign out everywhere"; an organization administrator can end a
 * member's. (A member of several organizations is signed out of all of them: a session belongs to the person, not to an organization.)
 */

/** True when the session was issued before the user's revocation moment. A session with no issue time cannot be proven newer, so it is void. */
export function sessionRevoked(issuedAtSeconds: number | undefined, validAfter: Date | null): boolean {
  if (!validAfter) return false;
  if (issuedAtSeconds === undefined || !Number.isFinite(issuedAtSeconds)) return true;
  // The token records whole seconds. It is void only if its whole issue second ended before the revocation, so someone who signs in again
  // in the same second as revoking is never locked out of their new session.
  return (Math.floor(issuedAtSeconds) + 1) * 1000 <= validAfter.getTime();
}

export async function getSessionsValidAfter(userId: string): Promise<Date | null> {
  return withTenant({ userId }, async (tx) => (await tx.user.findUnique({ where: { id: userId }, select: { sessionsValidAfter: true } }))?.sessionsValidAfter ?? null);
}

/** End every session of the signed-in person (including this one). */
export async function revokeOwnSessions(principal: Principal, at: Date = new Date()): Promise<void> {
  await withTenant({ organizationId: principal.organizationId, userId: principal.userId }, async (tx) => {
    await tx.$executeRaw`UPDATE "User" SET "sessionsValidAfter" = ${at}::timestamptz WHERE id = ${principal.userId}::uuid`; // row-level security: only their own row
    await recordAudit(tx, { organizationId: principal.organizationId, actorType: "USER", actorId: principal.userId, action: "session.revoked_self", entityType: "User", entityId: principal.userId, metadata: {} });
  });
}

export type RevokeOutcome = "REVOKED" | "NOT_A_MEMBER";

/** End every session of a member of this organization. Administrators only. */
export async function revokeMemberSessions(principal: Principal, targetUserId: string, at: Date = new Date()): Promise<RevokeOutcome> {
  assertCan(principal, "org:manage", { organizationId: principal.organizationId });
  return withTenant({ organizationId: principal.organizationId, userId: principal.userId }, async (tx): Promise<RevokeOutcome> => {
    const rows = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT revoke_member_sessions(${principal.organizationId}::uuid, ${targetUserId}::uuid, ${at}::timestamptz) AS ok`;
    if (rows[0]?.ok !== true) return "NOT_A_MEMBER";
    await recordAudit(tx, { organizationId: principal.organizationId, actorType: "USER", actorId: principal.userId, action: "session.revoked", entityType: "User", entityId: targetUserId, metadata: {} });
    return "REVOKED";
  });
}
