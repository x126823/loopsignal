import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { ActionForm } from "@/components/action-form";
import { formatDateTime, PROVIDER_LABEL, REVIEW_TYPE_LABEL, SIGNAL_LABEL, STATE_LABEL } from "@/lib/labels";
import { listAwaitingFollowUp, listCandidates } from "@/modules/correlation";
import { canResolveReviewTasks, listOpenReviewTasksPage } from "@/modules/lifecycle";
import { parseNotice } from "../../_lib/notices";
import { requireContext } from "../../_lib/session";
import { confirmCorrelationAction, rejectCorrelationAction, resolveReviewAction, retryFollowUpAction } from "../actions";

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireContext();
  const notice = parseNotice((await searchParams)["notice"]);
  // Cross-channel questions are decided on their own cards below (confirm or reject), never closed with a generic button.
  const { tasks, total: totalTasks } = await listOpenReviewTasksPage(ctx.principal, { limit: 100, excludeCorrelation: true });
  const canResolve = canResolveReviewTasks(ctx.principal);
  const [candidates, awaiting] = await Promise.all([listCandidates(ctx.principal, { status: "PENDING" }), listAwaitingFollowUp(ctx.principal)]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Review queue</h1>
        <p className="text-sm text-muted-foreground">Things the system could not decide safely: low-confidence results, messages it could not process, items that need an owner.</p>
      </div>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      {candidates.length > 0 && (
        <section className="flex flex-col gap-3" aria-label="Possible duplicates across channels" data-testid="correlation-candidates">
          <div>
            <h2 className="text-lg font-semibold">Possible duplicates across channels</h2>
            <p className="text-sm text-muted-foreground">A new message looks like something we already track. Nothing is attached or merged until a person decides: a wrong match hides work.</p>
          </div>
          {candidates.map((c) => (
            <Card key={c.id} data-testid="correlation-candidate">
              <CardHeader>
                <CardTitle>
                  <Link className="underline-offset-2 hover:underline" href={`/items/${c.target.itemId}`}>{c.target.title}</Link>
                </CardTitle>
                <CardDescription>
                  Existing item &middot; {STATE_LABEL[c.target.state as keyof typeof STATE_LABEL] ?? c.target.state} &middot; match score {Math.round(c.score * 100)}%
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <article className="rounded-md border border-border p-3" data-testid="candidate-message">
                  <header className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge tone="info">{PROVIDER_LABEL[c.subject.provider] ?? c.subject.provider}</Badge>
                    <span>{c.subject.senderName ?? "Unknown sender"}</span>
                    <time dateTime={c.subject.sentAt.toISOString()}>{formatDateTime(c.subject.sentAt)}</time>
                  </header>
                  {c.subject.subject && <h3 className="mt-1 text-sm font-medium">{c.subject.subject}</h3>}
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm">{c.subject.text}</p>
                </article>
                <ul className="flex flex-wrap gap-2 text-xs" data-testid="candidate-signals">
                  {c.signals.map((sg) => (
                    <li key={sg.name}><Badge tone={sg.value >= 0.7 ? "success" : sg.value > 0 ? "warning" : "neutral"}>{SIGNAL_LABEL[sg.name] ?? sg.name}: {sg.detail}</Badge></li>
                  ))}
                </ul>
                {c.verdict && (
                  <p className="text-xs text-muted-foreground" data-testid="candidate-verdict">
                    AI hint (a suggestion only): {c.verdict.sameMatter === "yes" ? "looks like the same matter" : c.verdict.sameMatter === "no" ? "looks like a different matter" : "not sure"} &middot; {Math.round(c.verdict.confidence * 100)}% confident.
                  </p>
                )}
                {c.canDecide ? (
                  <div className="flex flex-col gap-2">
                    <ActionForm action={confirmCorrelationAction} fields={{ candidateId: c.id }} showNote={false} summary="Same matter: attach to this item" submitLabel="Attach to this item"
                      description="The message's conversation is attached to the existing item, and no second item is created. You can detach it later unless it has already moved the item forward." />
                    <ActionForm action={rejectCorrelationAction} fields={{ candidateId: c.id }} showNote={false} variant="outline" summary="Different matter: keep separate" submitLabel="Keep separate"
                      description="The message will be tracked as its own item." />
                  </div>
                ) : <p className="text-sm text-muted-foreground">You can view this question but not decide it.</p>}
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      {awaiting.length > 0 && (
        <Card data-testid="awaiting-follow-up">
          <CardHeader>
            <CardTitle>Decisions waiting for follow-up</CardTitle>
            <CardDescription>These were decided, but the next step could not be queued. Retrying is safe.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {awaiting.map((a) => (
              <form key={a.candidateId} action={retryFollowUpAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="candidateId" value={a.candidateId} />
                <span>{a.status === "CONFIRMED" ? "Attached" : "Kept separate"} {formatDateTime(a.decidedAt)}</span>
                <Button type="submit" size="sm" variant="outline">Retry follow-up</Button>
              </form>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Open tasks</CardTitle>
          <CardDescription>{tasks.length === 0 ? "Nothing to review." : `${totalTasks > tasks.length ? `Showing the oldest ${tasks.length} of ${totalTasks} open tasks.` : `${tasks.length} open, oldest first.`}${canResolve ? "" : " You can read the queue but not close tasks."}`}</CardDescription>
        </CardHeader>
        {tasks.length > 0 && (
          <CardContent className="px-2">
            <Table>
              <THead><Tr><Th>Why</Th><Th>About</Th><Th>Opened</Th>{canResolve && <Th>Close it</Th>}</Tr></THead>
              <TBody>
                {tasks.map((t) => (
                  <Tr key={t.id}>
                    <Td><Badge tone="warning">{REVIEW_TYPE_LABEL[t.type] ?? t.type}</Badge></Td>
                    <Td>
                      {t.refType === "TrackedItem" && t.itemTitle
                        ? <Link className="font-medium underline-offset-2 hover:underline" href={`/items/${t.refId}`}>{t.itemTitle}</Link>
                        : <span className="text-muted-foreground">{t.refType === "Message" ? "A message" : t.refType === "RawEvent" ? "An incoming event" : t.refType === "AnalysisRun" ? "An analysis" : t.refType}</span>}
                    </Td>
                    <Td className="whitespace-nowrap text-muted-foreground">{formatDateTime(t.createdAt)}</Td>
                    {canResolve && (
                      <Td>
                        <form action={resolveReviewAction} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="taskId" value={t.id} />
                          <label className="sr-only" htmlFor={`res-${t.id}`}>Note</label>
                          <Input id={`res-${t.id}`} name="resolution" maxLength={500} placeholder="Note (optional)" className="h-8 w-44" />
                          <Button type="submit" name="status" value="RESOLVED" size="sm">Resolve</Button>
                          <Button type="submit" name="status" value="DISMISSED" size="sm" variant="outline">Dismiss</Button>
                        </form>
                      </Td>
                    )}
                  </Tr>
                ))}
              </TBody>
            </Table>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
