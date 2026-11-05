import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth, resolvePrincipal, type Principal } from "@/modules/identity";
import { listUserOrganizations } from "@/modules/tenancy";

/**
 * The data-access entry point for pages and server actions. It answers "who is this, in which organization, with which
 * role?" from the DATABASE on every request (never from the token), and every page and every server action calls it
 * itself. Server actions are reachable by direct POST, and layouts do not re-render on navigation, so protection cannot
 * live only in a layout or in the proxy.
 */
export const ORG_COOKIE = "loopsignal_org";

export interface AppContext {
  user: { id: string; email: string; name: string | null };
  org: { id: string; name: string; role: string };
  orgs: Array<{ id: string; name: string; role: string }>;
  principal: Principal;
}

/** The signed-in user, or null. No organization is needed. */
export const getSessionUser = cache(async () => {
  const session = await auth();
  const id = session?.user?.id;
  const email = session?.user?.email;
  return id && email ? { id, email, name: session?.user?.name ?? null } : null;
});

/** The full context, or null when signed out or when the user belongs to no organization. */
export const getContext = cache(async (): Promise<AppContext | null> => {
  const user = await getSessionUser();
  if (!user) return null;
  const orgs = await listUserOrganizations(user.id);
  if (orgs.length === 0) return null;
  // The cookie is a preference, validated against the user's real memberships every time. An unknown value falls back.
  const wanted = (await cookies()).get(ORG_COOKIE)?.value;
  const org = orgs.find((o) => o.id === wanted) ?? orgs[0]!;
  const principal = await resolvePrincipal(user.id, org.id);
  return principal ? { user, org, orgs, principal } : null;
});

export async function requireContext(): Promise<AppContext> {
  const ctx = await getContext();
  if (!ctx) redirect("/login");
  return ctx;
}
