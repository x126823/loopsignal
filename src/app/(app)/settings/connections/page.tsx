import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { formatDateTime } from "@/lib/labels";
import { listChatPeople } from "@/modules/ingestion";
import { chatEnabled, gmailEnabled, listChatSpaces, listGmailConnections } from "@/modules/sources";
import { listOrganizationUsers, listTeams } from "@/modules/tenancy";
import { parseNotice } from "../../../_lib/notices";
import { requireContext } from "../../../_lib/session";
import { connectGmailAction, disconnectGmailAction, linkChatPersonAction, removeChatSpaceAction, startChatClaimAction, syncNowAction, verifyChatClaimAction } from "./actions";

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
  const chatOn = chatEnabled();
  const [connections, teams] = enabled || chatOn ? await Promise.all([enabled ? listGmailConnections(ctx.principal) : [], listTeams(ctx.org.id)]) : [[], []];
  const [chat, people, users] = chatOn ? await Promise.all([listChatSpaces(ctx.principal), listChatPeople(ctx.principal), listOrganizationUsers(ctx.org.id)]) : [null, [], []];
  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? "No team";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Connections</h1>
        <p className="text-sm text-muted-foreground">Mailboxes LoopSignal reads to find requests. Access is read-only: it cannot send, delete or change mail.</p>
      </div>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      {!enabled && !chatOn && (
        <Card>
          <CardHeader><CardTitle>No connections are turned on</CardTitle><CardDescription>An operator enables Gmail with GMAIL_ENABLED and Google Chat with GOOGLE_CHAT_ENABLED once a Google test project is configured.</CardDescription></CardHeader>
        </Card>
      )}
      {enabled && (
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

      {chatOn && chat && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Connect a Google Chat space</CardTitle>
              <CardDescription>
                LoopSignal reads only spaces its Chat app has been added to, as the app, and only messages anyone in the space can see. Because one app serves every
                organization, you prove a space is yours by posting a one-time code in it.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form action={startChatClaimAction} className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor="space" className="text-sm font-medium">Space (name or link)</label>
                  <input id="space" name="space" required placeholder="spaces/AAAA… or a chat.google.com link" className="h-9 w-80 rounded-md border border-border bg-card px-3 text-sm" />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="chatTeamId" className="text-sm font-medium">Team that handles this space</label>
                  <Select id="chatTeamId" name="teamId" required className="w-64">{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
                </div>
                <Button type="submit" disabled={teams.length === 0}>Request code</Button>
              </form>
              {chat.pending.length > 0 && (
                <ul className="mt-4 flex flex-col gap-3" data-testid="chat-claims">
                  {chat.pending.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3 text-sm" data-testid="chat-claim">
                      <span className="flex flex-col">
                        <span>Add the LoopSignal Chat app to <code>{c.space}</code>, then post this code there:</span>
                        <code className="mt-1 w-fit rounded bg-muted px-2 py-1 text-base font-semibold" data-testid="chat-claim-code">{c.code}</code>
                        <span className="text-xs text-muted-foreground">Valid until {formatDateTime(c.expiresAt)} &middot; team {teamName(c.teamId)}</span>
                      </span>
                      <form action={verifyChatClaimAction}><input type="hidden" name="claimId" value={c.id} /><Button type="submit" size="sm">Verify</Button></form>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Connected spaces</CardTitle><CardDescription>{chat.spaces.length === 0 ? "None yet." : `${chat.spaces.length} space${chat.spaces.length === 1 ? "" : "s"}.`}</CardDescription></CardHeader>
            <CardContent>
              {chat.spaces.length > 0 && (
                <Table>
                  <THead><Tr><Th>Space</Th><Th>Team</Th><Th>Status</Th><Th>Last sync</Th><Th><span className="sr-only">Actions</span></Th></Tr></THead>
                  <TBody>
                    {chat.spaces.map((s) => (
                      <Tr key={s.id} data-testid="chat-space-row" data-enabled={s.enabled ? "true" : "false"}>
                        <Td data-testid="chat-space-name">{s.space}</Td>
                        <Td>{teamName(s.teamId)}</Td>
                        <Td><Badge data-testid="chat-space-status">{s.enabled ? "Connected" : "Disconnected"}</Badge></Td>
                        <Td>{s.lastSyncedAt ? formatDateTime(s.lastSyncedAt) : "Not yet"}</Td>
                        <Td>
                          {s.enabled && (
                            <div className="flex gap-2">
                              <form action={syncNowAction}><input type="hidden" name="sourceId" value={s.id} /><Button type="submit" size="sm" variant="outline">Sync now</Button></form>
                              <form action={removeChatSpaceAction}><input type="hidden" name="sourceId" value={s.id} /><Button type="submit" size="sm" variant="ghost">Disconnect</Button></form>
                            </div>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>People in Chat</CardTitle>
              <CardDescription>
                Chat shows only an opaque id for each person. Link the people who are on your team to their LoopSignal user, so their replies count as your team
                answering (acknowledgments and responses). It applies to messages collected after you link them.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {people.length === 0 ? <p className="text-sm text-muted-foreground">Nobody has written in a connected space yet.</p> : (
                <ul className="flex flex-col divide-y divide-border" data-testid="chat-people">
                  {people.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm" data-testid="chat-person">
                      <span>{p.displayName ?? "Unnamed person"}</span>
                      <form action={linkChatPersonAction} className="flex items-center gap-2">
                        <input type="hidden" name="participantId" value={p.id} />
                        <label htmlFor={`link-${p.id}`} className="sr-only">Team member for {p.displayName ?? "this person"}</label>
                        <Select id={`link-${p.id}`} name="userId" defaultValue={p.userId ?? ""} className="h-8 w-56 text-xs">
                          <option value="">Not on our team</option>
                          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </Select>
                        <Button type="submit" size="sm" variant="outline">Save</Button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
