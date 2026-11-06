import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { formatDateTime } from "@/lib/labels";
import { gmailEnabled, listGmailConnections } from "@/modules/sources";
import { listTeams } from "@/modules/tenancy";
import { parseNotice } from "../../../_lib/notices";
import { requireContext } from "../../../_lib/session";
import { connectGmailAction, disconnectGmailAction, syncNowAction } from "./actions";

const STATUS_LABEL = { ACTIVE: "Connected", PAUSED: "Paused", REVOKED: "Disconnected", ERROR: "Needs attention" } as const;

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireContext();
  const notice = parseNotice((await searchParams)["notice"]);

  if (ctx.org.role !== "ORG_ADMIN") {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">Connections</h1>
        <Notice tone="danger">Only organization admins can manage connections.</Notice>
      </div>
    );
  }

  const enabled = gmailEnabled();
  const [connections, teams] = enabled ? await Promise.all([listGmailConnections(ctx.principal), listTeams(ctx.org.id)]) : [[], []];
  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? "No team";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Connections</h1>
        <p className="text-sm text-muted-foreground">Mailboxes LoopSignal reads to find requests. Access is read-only: it cannot send, delete or change mail.</p>
      </div>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      {!enabled ? (
        <Card>
          <CardHeader><CardTitle>Gmail is turned off</CardTitle><CardDescription>An operator enables it with GMAIL_ENABLED once a Google test project is configured.</CardDescription></CardHeader>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Connect a Gmail mailbox</CardTitle>
              <CardDescription>You will be sent to Google to approve read-only access. Messages are stored encrypted and analyzed as untrusted data.</CardDescription>
            </CardHeader>
            <CardContent>
              <form action={connectGmailAction} className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor="teamId" className="text-sm font-medium">Team that handles this mailbox</label>
                  <Select id="teamId" name="teamId" required className="w-64">
                    {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </Select>
                </div>
                <Button type="submit" disabled={teams.length === 0}>Connect Gmail</Button>
              </form>
              {teams.length === 0 && <p className="mt-2 text-sm text-muted-foreground">Create a team first.</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Connected mailboxes</CardTitle><CardDescription>{connections.length === 0 ? "None yet." : `${connections.length} connection${connections.length === 1 ? "" : "s"}.`}</CardDescription></CardHeader>
            <CardContent>
              {connections.length > 0 && (
                <Table>
                  <THead><Tr><Th>Mailbox</Th><Th>Team</Th><Th>Status</Th><Th>Last sync</Th><Th>Push</Th><Th><span className="sr-only">Actions</span></Th></Tr></THead>
                  <TBody>
                    {connections.flatMap((c) => c.sources.map((s) => (
                      <Tr key={s.id} data-testid="connection-row" data-status={c.status}>
                        <Td data-testid="connection-mailbox">{s.mailbox}</Td>
                        <Td>{teamName(s.teamId)}</Td>
                        <Td><Badge data-testid="connection-status">{STATUS_LABEL[c.status]}</Badge></Td>
                        <Td>{s.lastSyncedAt ? formatDateTime(s.lastSyncedAt) : "Not yet"}</Td>
                        <Td>{c.watchExpiresAt ? `Until ${formatDateTime(c.watchExpiresAt)}` : "Polling"}</Td>
                        <Td>
                          <div className="flex gap-2">
                            {c.status === "ACTIVE" && (
                              <form action={syncNowAction}><input type="hidden" name="sourceId" value={s.id} /><Button type="submit" size="sm" variant="outline">Sync now</Button></form>
                            )}
                            {c.status !== "REVOKED" && (
                              <form action={disconnectGmailAction}><input type="hidden" name="connectionId" value={c.id} /><Button type="submit" size="sm" variant="ghost">Disconnect</Button></form>
                            )}
                          </div>
                        </Td>
                      </Tr>
                    )))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
