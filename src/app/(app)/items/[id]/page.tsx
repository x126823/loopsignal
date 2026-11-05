import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ActionForm } from "@/components/action-form";
import { StateBadge } from "@/components/item-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { describeActor, formatDateTime, PRIORITY_LABEL, REVIEW_TYPE_LABEL, STATE_LABEL, TRANSITION_LABEL } from "@/lib/labels";
import { can } from "@/modules/identity";
import { loadThreadMessages } from "@/modules/ingestion";
import { listItemAnalysis } from "@/modules/intelligence";
import { getApprovalPolicy, getItemDetail } from "@/modules/lifecycle";
import { listTeamCandidates } from "@/modules/tenancy";
import { availableTransitions, canDecideApproval, transitionButtonLabel } from "../../../_lib/available-actions";
import { parseNotice } from "../../../_lib/notices";
import { requireContext } from "../../../_lib/session";
import { assignOwnerAction, decideApprovalAction, transitionAction } from "../../actions";

const DIRECTION_LABEL = { INBOUND: "From outside", OUTBOUND: "Our team", INTERNAL: "Internal" } as const;

const CONSEQUENCE: Partial<Record<string, string>> = {
  RESOLUTION_CONFIRMED: "Confirming records that the problem is resolved. It does not close the item: closing is a separate, final step.",
  CLOSED: "Closing is the final step. The item stops being tracked as open. It can still be reopened later if the problem returns.",
  REOPENED: "Reopening starts a new cycle. The earlier history is kept.",
  IN_PROGRESS: "The proposal is rejected and the item goes back to work.",
};

export default async function ItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireContext();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const notice = parseNotice((await searchParams)["notice"]);

  // Anything the principal may not see is simply "not found": no hint that the item exists.
  const detail = await getItemDetail(ctx.principal, id);
  if (!detail) notFound();
  const { item, events, approvals, openReviewTasks } = detail;

  const resource = { organizationId: ctx.org.id, teamId: item.teamId };
  const canAct = can(ctx.principal, "item:act", resource);
  const policy = await getApprovalPolicy(ctx.principal);
  const [messages, analyses, candidates] = await Promise.all([
    loadThreadMessages(ctx.org.id, item.threadId),
    listItemAnalysis(ctx.org.id, item.id, 12),
    canAct ? listTeamCandidates(ctx.org.id, item.teamId) : Promise.resolve([]),
  ]);

  const itemRef = { organizationId: ctx.org.id, state: item.state, teamId: item.teamId };
  const offered = availableTransitions(ctx.principal, itemRef, policy);
  const pending = approvals.filter((a) => a.status === "PENDING");
  const sender = new Map(messages.map((m) => [m.id, m.senderName ?? m.senderAddress ?? DIRECTION_LABEL[m.direction]]));
  const base = { itemId: item.id, expectedVersion: String(item.version) };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm"><Link href="/items" className="text-muted-foreground hover:underline">&larr; Items</Link></p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{item.title}</h1>
          <StateBadge state={item.state} />
          <Badge>{PRIORITY_LABEL[item.priority]} priority</Badge>
          {item.needsReview && <Badge tone="warning">Needs review</Badge>}
          {item.reopenCount > 0 && <Badge tone="danger">Reopened {item.reopenCount}&times;</Badge>}
        </div>
      </div>

      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {(offered.length > 0 || pending.length > 0) && (
            <Card>
              <CardHeader>
                <CardTitle>Decisions</CardTitle>
                <CardDescription>Only people can confirm, close or reopen. Nothing here happens automatically.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {pending.map((a) => {
                  const quotes = analyses.filter((r) => r.recommendedAction === `TRANSITION_${a.requestedTransition}`).flatMap((r) => r.evidence).slice(0, 3);
                  const decide = canDecideApproval(ctx.principal, itemRef, a.requestedTransition, policy);
                  return (
                    <div key={a.id} className="rounded-md border border-border p-3" data-testid="pending-approval">
                      <p className="text-sm font-medium">Suggested: {TRANSITION_LABEL[a.requestedTransition] ?? a.requestedTransition}</p>
                      <p className="text-xs text-muted-foreground">Asked {formatDateTime(a.createdAt)}{a.reason ? ` — ${a.reason}` : ""}</p>
                      {quotes.length > 0 && (
                        <ul className="mt-2 list-disc pl-5 text-sm">
                          {quotes.map((q, i) => <li key={i}>&ldquo;{q.quote}&rdquo; <span className="text-muted-foreground">({sender.get(q.messageId) ?? "a message"})</span></li>)}
                        </ul>
                      )}
                      {decide ? (
                        <div className="mt-3 flex flex-col gap-2">
                          <ActionForm action={decideApprovalAction} fields={{ ...base, approvalRequestId: a.id, decision: "APPROVE" }} summary="Approve this request" submitLabel="Approve" description={CONSEQUENCE[a.requestedTransition]} />
                          <ActionForm action={decideApprovalAction} fields={{ ...base, approvalRequestId: a.id, decision: "REJECT" }} summary="Reject this request" submitLabel="Reject" variant="outline" />
                        </div>
                      ) : <p className="mt-2 text-sm text-muted-foreground">You can view this request but not decide it.</p>}
                    </div>
                  );
                })}
                {offered.filter((to) => !pending.some((a) => a.requestedTransition === to)).map((to) => (
                  <ActionForm
                    key={to}
                    action={transitionAction}
                    fields={{ ...base, to }}
                    summary={transitionButtonLabel(item.state, to)}
                    submitLabel={transitionButtonLabel(item.state, to)}
                    variant={to === "REOPENED" || to === "IN_PROGRESS" || to === "RESOLUTION_PROPOSED" ? "outline" : "default"}
                    description={CONSEQUENCE[to]}
                    noteLabel={to === "IN_PROGRESS" ? "Why is the proposal rejected? (optional)" : undefined}
                  />
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Conversation</CardTitle>
              <CardDescription>{messages.length} message{messages.length === 1 ? "" : "s"}, oldest first. Visible to people allowed to view this item.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {messages.map((m) => (
                <article key={m.id} className="rounded-md border border-border p-3" data-testid="message">
                  <header className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge tone={m.direction === "INBOUND" ? "neutral" : "info"}>{DIRECTION_LABEL[m.direction]}</Badge>
                    <span>{m.senderName ?? m.senderAddress ?? "Unknown sender"}</span>
                    <time dateTime={m.sentAt.toISOString()}>{formatDateTime(m.sentAt)}</time>
                  </header>
                  {m.subject && <h3 className="mt-1 text-sm font-medium">{m.subject}</h3>}
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm">{m.text}</p>
                </article>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
              <CardDescription>Every change, who or what made it, and why. Recorded permanently.</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="flex flex-col gap-3 text-sm">
                {events.map((e) => (
                  <li key={e.seq} className="border-l-2 border-border pl-3" data-testid="event">
                    <p>
                      <span className="font-medium">{e.fromState ? `${STATE_LABEL[e.fromState]} → ` : ""}{STATE_LABEL[e.toState]}</span>
                      {e.cycle > 1 && <span className="ml-2 text-xs text-muted-foreground">cycle {e.cycle}</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">{describeActor(e)} &middot; {formatDateTime(e.createdAt)}{e.reason ? ` — ${e.reason}` : ""}</p>
                    {e.evidence.length > 0 && <p className="mt-1 text-xs italic">&ldquo;{e.evidence[0]!.quote}&rdquo;</p>}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Where it stands</CardTitle>
              <CardDescription>Four separate facts. Each is recorded from its own event.</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-sm" data-testid="metrics">
                <dt className="text-muted-foreground">Acknowledged</dt><dd data-testid="metric-ack">{formatDateTime(item.ackAt)}</dd>
                <dt className="text-muted-foreground">First substantive response</dt><dd data-testid="metric-response">{formatDateTime(item.firstSubstantiveResponseAt)}</dd>
                <dt className="text-muted-foreground">Resolution confirmed</dt><dd data-testid="metric-resolved">{formatDateTime(item.resolvedAt)}</dd>
                <dt className="text-muted-foreground">Closed</dt><dd data-testid="metric-closed">{formatDateTime(item.closedAt)}</dd>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Ownership</CardTitle>
              <CardDescription>{item.teamName} team &middot; owner: {item.ownerName ?? "unassigned"}</CardDescription>
            </CardHeader>
            {canAct && (
              <CardContent>
                <form action={assignOwnerAction} className="flex flex-col gap-2">
                  <input type="hidden" name="itemId" value={item.id} />
                  <label htmlFor="owner" className="text-sm font-medium">Assign owner</label>
                  <Select id="owner" name="userId" defaultValue={item.ownerUserId ?? ""}>
                    <option value="">Unassigned</option>
                    {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                  <div><Button type="submit" variant="outline" size="sm">Save owner</Button></div>
                </form>
              </CardContent>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>AI recommendations</CardTitle>
              <CardDescription>Suggestions only. Each cites exact words from the conversation.</CardDescription>
            </CardHeader>
            <CardContent>
              {analyses.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p> : (
                <ul className="flex flex-col gap-3 text-sm" data-testid="analyses">
                  {analyses.map((r) => (
                    <li key={r.id}>
                      <p className="font-medium">{r.analyzer.replace(/_/g, " ")}</p>
                      <p className="text-xs text-muted-foreground">
                        {r.recommendedAction?.replace(/_/g, " ").toLowerCase() ?? "no action"}{r.confidence !== null ? ` · ${Math.round(r.confidence * 100)}% confident` : ""}{r.requiresHumanApproval ? " · needs a person" : ""}
                      </p>
                      {r.evidence[0] && <p className="mt-0.5 text-xs italic">&ldquo;{r.evidence[0].quote}&rdquo;</p>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {openReviewTasks.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Open review tasks</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {openReviewTasks.map((t) => <p key={t.id}><Badge tone="warning">{REVIEW_TYPE_LABEL[t.type] ?? t.type}</Badge></p>)}
                <Link href="/review" className="text-sm underline-offset-2 hover:underline">Open the review queue</Link>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
