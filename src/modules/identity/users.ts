import { withTenant } from "@/lib/db";

/** Sign-in lookup. Users are invite-only: this never creates a user. */
export async function findUserByEmail(email: string): Promise<{ id: string; email: string; name: string | null } | null> {
  const normalized = email.trim().toLowerCase();
  return withTenant({ loginEmail: normalized }, (tx) =>
    tx.user.findUnique({ where: { email: normalized }, select: { id: true, email: true, name: true } }),
  );
}
