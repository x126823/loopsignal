import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { StateBadge } from "@/components/item-state";
import { formatDateTime, TRANSITION_LABEL } from "@/lib/labels";
import { getApprovalPolicy, listPendingApprovals } from "@/modules/lifecycle";
import { canDecideApproval } from "../../_lib/available-actions";
import { parseNotice } from "../../_lib/notices";
import { requireContext } from "../../_lib/session";

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireContext();
  const notice = parseNotice((await searchParams)["notice"]);
  const [approvals, policy] = await Promise.all([listPendingApprovals(ctx.principal), getApprovalPolicy(ctx.principal)]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="text-sm text-muted-foreground">Decisions that only a person can make. The system can suggest a confirmation, a closure or a reopening; it never applies one.</p>
      </div>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      <Card>
        <CardHeader>
          <CardTitle>Waiting for a decision</CardTitle>
          <CardDescription>{approvals.length === 0 ? "Nothing is waiting." : `${approvals.length} request${approvals.length === 1 ? "" : "s"}, oldest first.`}</CardDescription>
        </CardHeader>
        {approvals.length > 0 && (
          <CardContent className="px-2">
            <Table>
              <THead><Tr><Th>Item</Th><Th>Now</Th><Th>Requested</Th><Th>Asked</Th><Th>You</Th></Tr></THead>
              <TBody>
                {approvals.map((a) => {
                  const decide = canDecideApproval(ctx.principal, { organizationId: ctx.org.id, state: a.itemState, teamId: a.teamId }, a.requestedTransition, policy);
                  return (
                    <Tr key={a.id}>
                      <Td><Link className="font-medium underline-offset-2 hover:underline" href={`/items/${a.itemId}`}>{a.itemTitle}</Link></Td>
                      <Td><StateBadge state={a.itemState} /></Td>
                      <Td>{TRANSITION_LABEL[a.requestedTransition] ?? a.requestedTransition}</Td>
                      <Td className="whitespace-nowrap text-muted-foreground">{formatDateTime(a.createdAt)}</Td>
                      <Td className="text-muted-foreground">{decide ? "Can decide" : "View only"}</Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
