import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { StateBadge } from "@/components/item-state";
import { formatDateTime, PRIORITY_LABEL } from "@/lib/labels";
import { listVisibleItems } from "@/modules/lifecycle";
import { requireContext } from "../../_lib/session";

const VIEWS = [["open", "Open"], ["closed", "Closed"], ["all", "All"]] as const;

export default async function ItemsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireContext();
  const raw = (await searchParams)["view"];
  const view = VIEWS.find(([v]) => v === (Array.isArray(raw) ? raw[0] : raw))?.[0] ?? "open";
  const items = await listVisibleItems(ctx.principal, { view, limit: 100 });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Items</h1>
          <p className="text-sm text-muted-foreground">Everything being tracked that you are allowed to see.</p>
        </div>
        <nav aria-label="Filter" className="flex gap-1 text-sm">
          {VIEWS.map(([v, label]) => (
            <Link key={v} href={`/items?view=${v}`} aria-current={v === view ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 ${v === view ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>{label}</Link>
          ))}
        </nav>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{VIEWS.find(([v]) => v === view)?.[1]} items</CardTitle>
          <CardDescription>{items.length === 0 ? "Nothing to show." : `${items.length} shown, newest first.`}</CardDescription>
        </CardHeader>
        {items.length > 0 && (
          <CardContent className="px-2">
            <Table>
              <THead><Tr><Th>Item</Th><Th>State</Th><Th>Priority</Th><Th>Owner</Th><Th>Received</Th></Tr></THead>
              <TBody>
                {items.map((i) => (
                  <Tr key={i.id}>
                    <Td>
                      <Link className="font-medium underline-offset-2 hover:underline" href={`/items/${i.id}`}>{i.title}</Link>
                      {i.needsReview && <Badge tone="warning" className="ml-2">Needs review</Badge>}
                    </Td>
                    <Td><StateBadge state={i.state} /></Td>
                    <Td>{PRIORITY_LABEL[i.priority]}</Td>
                    <Td>{i.ownerName ?? <span className="text-muted-foreground">Unassigned</span>}</Td>
                    <Td className="whitespace-nowrap text-muted-foreground">{formatDateTime(i.createdAt)}</Td>
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
