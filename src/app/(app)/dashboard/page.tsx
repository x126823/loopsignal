import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { systemClock } from "@/lib/clock";
import { PRIORITY_LABEL, STATE_LABEL } from "@/lib/labels";
import { getDashboard, METRIC_KEYS, WINDOW_DAYS, type MetricKey, type Rollup } from "@/modules/reporting";
import { TIMER_LABEL } from "../../_lib/sla-display";
import { formatDuration, formatPercent } from "../../_lib/format";
import { requireContext } from "../../_lib/session";

const METRIC_LABEL: Record<MetricKey, { title: string; help: string }> = {
  acknowledgment: { title: "Acknowledgment", help: "Time until we confirmed we had the request." },
  response: { title: "First substantive response", help: "Time until we actually engaged with it. An acknowledgment does not count." },
  resolution: { title: "Resolution", help: "Time until a person confirmed it was resolved. A proposed fix does not count." },
  closure: { title: "Closure", help: "Time until a person closed it. A confirmation alone does not count." },
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const days = Number(first(sp["days"]));
  const team = first(sp["team"]);
  const dash = await getDashboard(ctx.principal, { days, ...(team ? { teamId: team } : {}) }, { clock: systemClock });
  const { data } = dash;
  const teamName = new Map(dash.teams.map((t) => [t.id, t.name]));
  const scope = dash.teamId ? (teamName.get(dash.teamId) ?? "this team") : dash.teams.length > 1 ? "all your teams" : (dash.teams[0]?.name ?? "your team");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {scope}: {data.items} item{data.items === 1 ? "" : "s"} received in the last {dash.window.days} days. Only items you may view are counted.
          </p>
        </div>
        <form method="get" className="flex flex-wrap items-center gap-2" aria-label="Filter">
          <label htmlFor="days" className="sr-only">Period</label>
          <Select id="days" name="days" defaultValue={String(dash.window.days)} className="h-8 w-auto text-xs">
            {WINDOW_DAYS.map((d) => <option key={d} value={d}>Last {d} days</option>)}
          </Select>
          {dash.teams.length > 1 && (
            <>
              <label htmlFor="team" className="sr-only">Team</label>
              <Select id="team" name="team" defaultValue={dash.teamId ?? ""} className="h-8 w-auto text-xs">
                <option value="">All teams</option>
                {dash.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </>
          )}
          <Button type="submit" size="sm" variant="outline">Apply</Button>
        </form>
      </div>

      <section aria-label="The four metrics" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="metrics">
        {METRIC_KEYS.map((k) => {
          const m = data.metrics[k];
          return (
            <Card key={k} data-testid={`metric-${k}`}>
              <CardHeader>
                <CardTitle>{METRIC_LABEL[k].title}</CardTitle>
                <CardDescription>{METRIC_LABEL[k].help}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold" data-testid={`median-${k}`}>{formatDuration(m.medianSec)}</p>
                <p className="text-xs text-muted-foreground">median &middot; 90% within {formatDuration(m.p90Sec)}</p>
                <p className="mt-2 text-sm"><span data-testid={`achieved-${k}`}>{m.achieved}</span> reached, <span data-testid={`pending-${k}`}>{m.pending}</span> still waiting</p>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Deadlines kept</CardTitle>
            <CardDescription>Of the deadlines already decided, how many were met. Timers still running are not counted.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <THead><Tr><Th>Deadline</Th><Th>Met</Th><Th>Missed</Th><Th>Due soon</Th><Th>Kept</Th></Tr></THead>
              <TBody>
                {(["ACK", "RESPONSE", "RESOLVE", "CLOSE"] as const).map((t) => {
                  const s = data.sla[t];
                  return (
                    <Tr key={t} data-testid={`sla-row-${t.toLowerCase()}`}>
                      <Td>{TIMER_LABEL[t]}</Td><Td>{s.met}</Td><Td>{s.breached}</Td><Td>{s.warned}</Td>
                      <Td>
                        <span className="flex items-center gap-2">
                          <span aria-hidden className="h-2 w-16 overflow-hidden rounded bg-muted"><span className="block h-full bg-primary" style={{ width: `${s.attainmentPct ?? 0}%` }} /></span>
                          {formatPercent(s.attainmentPct)}
                        </span>
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Where items stand</CardTitle>
            <CardDescription>{data.open} open, {data.closed} closed{data.reopened > 0 ? `, ${data.reopened} reopened at least once` : ""}.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-wrap gap-2 text-sm" data-testid="states">
              {Object.entries(data.byState).map(([state, n]) => <li key={state}><Badge>{STATE_LABEL[state as keyof typeof STATE_LABEL] ?? state}: {n}</Badge></li>)}
              {data.items === 0 && <li className="text-muted-foreground">No items in this period.</li>}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Needs attention</CardTitle>
          <CardDescription>Open items with a missed or due-soon deadline, most urgent first.</CardDescription>
        </CardHeader>
        <CardContent className="px-2">
          {data.attention.length === 0 ? <p className="px-4 text-sm text-muted-foreground">Nothing is overdue or due soon.</p> : (
            <Table>
              <THead><Tr><Th>Item</Th><Th>Priority</Th><Th>Stands</Th><Th>Missed</Th><Th>Due soon</Th></Tr></THead>
              <TBody>
                {data.attention.slice(0, 25).map((a) => (
                  <Tr key={a.itemId} data-testid="attention-row">
                    <Td><Link className="font-medium underline-offset-2 hover:underline" href={`/items/${a.itemId}`}>{a.title}</Link></Td>
                    <Td>{PRIORITY_LABEL[a.priority]}</Td>
                    <Td>{STATE_LABEL[a.state]}</Td>
                    <Td>{a.overdue.length ? a.overdue.map((t) => TIMER_LABEL[t]).join(", ") : "—"}</Td>
                    <Td>{a.dueSoon.length ? a.dueSoon.map((t) => TIMER_LABEL[t]).join(", ") : "—"}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {!dash.teamId && data.teams.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>By team</CardTitle>
            <CardDescription>Median time for each metric, and how many are still waiting.</CardDescription>
          </CardHeader>
          <CardContent className="px-2">
            <Table>
              <THead><Tr><Th>Team</Th><Th>Items</Th>{METRIC_KEYS.map((k) => <Th key={k}>{METRIC_LABEL[k].title}</Th>)}<Th>Missed deadlines</Th></Tr></THead>
              <TBody>
                {data.teams.map(({ teamId, rollup }: { teamId: string; rollup: Rollup }) => (
                  <Tr key={teamId} data-testid="team-row">
                    <Td><Link className="underline-offset-2 hover:underline" href={`/dashboard?days=${dash.window.days}&team=${teamId}`}>{teamName.get(teamId) ?? "Team"}</Link></Td>
                    <Td>{rollup.items}</Td>
                    {METRIC_KEYS.map((k) => <Td key={k}>{formatDuration(rollup.metrics[k].medianSec)} <span className="text-xs text-muted-foreground">({rollup.metrics[k].pending} waiting)</span></Td>)}
                    <Td>{rollup.breachedTimers}</Td>
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
