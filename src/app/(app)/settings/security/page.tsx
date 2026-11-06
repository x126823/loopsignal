import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { listOrganizationUsers } from "@/modules/tenancy";
import { parseNotice } from "../../../_lib/notices";
import { requireContext } from "../../../_lib/session";
import { revokeMemberSessionsAction, signOutEverywhereAction } from "./actions";

export default async function SecurityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireContext();
  const notice = parseNotice((await searchParams)["notice"]);
  const isAdmin = ctx.org.role === "ORG_ADMIN";
  const members = isAdmin ? await listOrganizationUsers(ctx.org.id) : [];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Security</h1>
        <p className="text-sm text-muted-foreground">A sign-in lasts a limited time, and can be ended early.</p>
      </div>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <Card>
        <CardHeader>
          <CardTitle>Sign out everywhere</CardTitle>
          <CardDescription>
            Ends every session of your account on every device, including this one. Use it if you lost a device, used a shared computer, or think someone else may have your session.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={signOutEverywhereAction}><Button type="submit" variant="outline">Sign out everywhere</Button></form>
        </CardContent>
      </Card>

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Members</CardTitle>
            <CardDescription>
              End all sessions of a member who lost a device or whose account may be compromised. They stay a member and sign in again. A person who belongs to several
              organizations is signed out of all of them, because a session belongs to the person.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <THead><Tr><Th>Member</Th><Th><span className="sr-only">Actions</span></Th></Tr></THead>
              <TBody>
                {members.map((m) => (
                  <Tr key={m.id} data-testid="member-row">
                    <Td>{m.name}</Td>
                    <Td><form action={revokeMemberSessionsAction}><input type="hidden" name="userId" value={m.id} /><Button type="submit" size="sm" variant="outline">Sign out everywhere</Button></form></Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
