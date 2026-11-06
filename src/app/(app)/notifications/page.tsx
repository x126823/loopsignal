import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { formatDateTime } from "@/lib/labels";
import { CHANNELS, listNotifications, listPreferences, NOTIFICATION_TYPES, TYPE_LABEL } from "@/modules/notifications";
import { parseNotice } from "../../_lib/notices";
import { requireContext } from "../../_lib/session";
import { markNotificationReadAction, savePreferencesAction } from "../actions";

const CHANNEL_LABEL = { IN_APP: "In the app", EMAIL: "Email" } as const;

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireContext();
  const notice = parseNotice((await searchParams)["notice"]);
  const [items, prefs] = await Promise.all([listNotifications(ctx.principal, { limit: 50 }), listPreferences(ctx.principal)]);
  const unread = items.filter((n) => n.readAt === null).length;
  const enabled = (type: string, channel: string) => prefs.find((p) => p.type === type && p.channel === channel)?.enabled ?? false;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Notifications</h1>
        <p className="text-sm text-muted-foreground">Things that need your attention. These are links to the work, not copies of it.</p>
      </div>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <Card>
        <CardHeader>
          <CardTitle>Inbox</CardTitle>
          <CardDescription>{items.length === 0 ? "Nothing yet." : `${unread} unread of ${items.length}, newest first.`}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {unread > 0 && (
            <form action={markNotificationReadAction}>
              <input type="hidden" name="id" value="all" />
              <Button type="submit" size="sm" variant="outline">Mark all as read</Button>
            </form>
          )}
          <ul className="flex flex-col divide-y divide-border" data-testid="notification-list">
            {items.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm" data-testid="notification" data-read={n.readAt ? "true" : "false"}>
                <span className="flex flex-col">
                  <Link href={n.href} className={`${n.readAt ? "" : "font-medium"} underline-offset-2 hover:underline`}>{n.text}</Link>
                  <span className="text-xs text-muted-foreground">{TYPE_LABEL[n.type]} &middot; {formatDateTime(n.createdAt)}</span>
                </span>
                {n.readAt ? <Badge>Read</Badge> : (
                  <form action={markNotificationReadAction}>
                    <input type="hidden" name="id" value={n.id} />
                    <Button type="submit" size="sm" variant="ghost">Mark read</Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>Choose what you hear about. Email is not sent yet: a choice made here is remembered for when it is.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={savePreferencesAction} className="flex flex-col gap-3" data-testid="preferences">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-muted-foreground"><th className="py-1 pr-4 font-medium">Event</th>{CHANNELS.map((c) => <th key={c} className="px-3 py-1 font-medium">{CHANNEL_LABEL[c]}</th>)}</tr></thead>
              <tbody>
                {NOTIFICATION_TYPES.map((type) => (
                  <tr key={type} className="border-t border-border">
                    <td className="py-2 pr-4">{TYPE_LABEL[type]}</td>
                    {CHANNELS.map((channel) => (
                      <td key={channel} className="px-3 py-2">
                        <input type="checkbox" name={`pref:${type}:${channel}`} defaultChecked={enabled(type, channel)} aria-label={`${TYPE_LABEL[type]}: ${CHANNEL_LABEL[channel]}`} className="h-4 w-4" />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div><Button type="submit">Save settings</Button></div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
