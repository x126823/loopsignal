import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { countPendingApprovals } from "@/modules/lifecycle";
import { countUnread } from "@/modules/notifications";
import { signOutAction } from "../login/actions";
import { requireContext } from "../_lib/session";
import { switchOrganizationAction } from "./actions";

export const dynamic = "force-dynamic"; // every page here depends on who is signed in

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requireContext();
  const pending = await countPendingApprovals(ctx.principal);
  const unread = await countUnread(ctx.principal);
  const roleLabel = ctx.org.role.replace("_", " ").toLowerCase();

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/approvals" className="text-base font-semibold">LoopSignal</Link>
          <nav aria-label="Main" className="flex items-center gap-4 text-sm">
            <Link href="/approvals" className="hover:underline">
              Approvals{pending > 0 && <span className="ml-1.5 rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground" aria-label={`${pending} pending`}>{pending}</span>}
            </Link>
            <Link href="/dashboard" className="hover:underline">Dashboard</Link>
            <Link href="/items" className="hover:underline">Items</Link>
            <Link href="/review" className="hover:underline">Review queue</Link>
            {ctx.org.role === "ORG_ADMIN" && <Link href="/settings/connections" className="hover:underline" data-testid="nav-connections">Connections</Link>}
            {ctx.org.role === "ORG_ADMIN" && <Link href="/settings/retention" className="hover:underline" data-testid="nav-retention">Retention</Link>}
            <Link href="/settings/security" className="hover:underline" data-testid="nav-security">Security</Link>
            <Link href="/notifications" className="hover:underline" data-testid="nav-notifications">
              Notifications{unread > 0 && <span className="ml-1.5 rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground" aria-label={`${unread} unread`} data-testid="unread-count">{unread}</span>}
            </Link>
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-3 text-sm">
            {ctx.orgs.length > 1 ? (
              <form action={switchOrganizationAction} className="flex items-center gap-2">
                <label htmlFor="organizationId" className="sr-only">Organization</label>
                <Select id="organizationId" name="organizationId" defaultValue={ctx.org.id} className="h-8 w-auto text-xs">
                  {ctx.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
                <Button type="submit" size="sm" variant="outline">Switch</Button>
              </form>
            ) : (
              <span className="text-muted-foreground">{ctx.org.name}</span>
            )}
            <span className="text-muted-foreground" title={ctx.user.email}>{ctx.user.name ?? ctx.user.email} ({roleLabel})</span>
            <form action={signOutAction}>
              <Button type="submit" size="sm" variant="ghost">Sign out</Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
