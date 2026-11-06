import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { formatDateTime } from "@/lib/labels";
import { getRetentionStatus, RETENTION_LIMITS } from "@/modules/retention";
import { parseNotice } from "../../../_lib/notices";
import { requireContext } from "../../../_lib/session";
import { saveRetentionAction } from "./actions";

export default async function RetentionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireContext();
  const notice = parseNotice((await searchParams)["notice"]);
  if (ctx.org.role !== "ORG_ADMIN") {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">Data retention</h1>
        <Notice tone="danger">Only organization admins can manage data retention.</Notice>
      </div>
    );
  }
  const status = await getRetentionStatus(ctx.principal);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Data retention</h1>
        <p className="text-sm text-muted-foreground">How long stored message content is kept. Items, their history and the audit log hold ids and metadata, not message text, and are kept.</p>
      </div>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <Card>
        <CardHeader>
          <CardTitle>Windows</CardTitle>
          <CardDescription>
            A daily pass removes content that is past its window. Content of an item that is still open is never removed. Message bodies and the quotes copied from them
            go this many days after their item closed (or after they arrived, if they belong to no item).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={saveRetentionAction} className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="rawEventDays" className="text-sm font-medium">Raw provider payloads (days after receipt)</label>
              <Input id="rawEventDays" name="rawEventDays" type="number" required min={RETENTION_LIMITS.rawEventDays.min} max={RETENTION_LIMITS.rawEventDays.max} defaultValue={status.settings.rawEventDays} className="w-40" />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="messageDays" className="text-sm font-medium">Message bodies and quotes (days)</label>
              <Input id="messageDays" name="messageDays" type="number" required min={RETENTION_LIMITS.messageDays.min} max={RETENTION_LIMITS.messageDays.max} defaultValue={status.settings.messageDays} className="w-40" />
            </div>
            <Button type="submit">Save</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Status</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p data-testid="last-purge">
            {status.lastPurge
              ? `Last removal: ${formatDateTime(status.lastPurge.at)} (${status.lastPurge.rawEvents} raw payload${status.lastPurge.rawEvents === 1 ? "" : "s"}, ${status.lastPurge.messages} message${status.lastPurge.messages === 1 ? "" : "s"}).`
              : "Nothing has been removed yet."}
          </p>
          <p data-testid="last-verification">
            {status.lastVerification
              ? status.lastVerification.intact
                ? `Audit log verified intact on ${formatDateTime(status.lastVerification.at)}.`
                : `Audit log check FAILED on ${formatDateTime(status.lastVerification.at)}: records may have been altered outside the application. Follow the audit-chain runbook.`
              : "The audit log has not been checked yet (it is checked daily)."}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
