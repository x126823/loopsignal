import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { formatDateTime, REVIEW_TYPE_LABEL } from "@/lib/labels";
import { canResolveReviewTasks, listOpenReviewTasks } from "@/modules/lifecycle";
import { parseNotice } from "../../_lib/notices";
import { requireContext } from "../../_lib/session";
import { resolveReviewAction } from "../actions";

export default async function ReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireContext();
  const notice = parseNotice((await searchParams)["notice"]);
  const tasks = await listOpenReviewTasks(ctx.principal);
  const canResolve = canResolveReviewTasks(ctx.principal);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Review queue</h1>
        <p className="text-sm text-muted-foreground">Things the system could not decide safely: low-confidence results, messages it could not process, items that need an owner.</p>
      </div>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      <Card>
        <CardHeader>
          <CardTitle>Open tasks</CardTitle>
          <CardDescription>{tasks.length === 0 ? "Nothing to review." : `${tasks.length} open, oldest first.${canResolve ? "" : " You can read the queue but not close tasks."}`}</CardDescription>
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
