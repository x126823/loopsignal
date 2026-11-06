import { expect, test } from "@playwright/test";
import { cleanup, closeDb, newOrg, newSlaItem, notify, signIn, sql, type Fx } from "./support";

/**
 * Sprint 10, in a real browser: a person's inbox is theirs alone, read state and settings persist, and a setting they turn off
 * really stops that notification. Notifications are raised through the same module call the workers use.
 */
const count = async (userId: string, type: string, channel = "IN_APP") =>
  Number((await sql<{ n: string }>(`select count(*) as n from "Notification" where "recipientUserId" = $1 and type = $2 and channel = $3::"NotificationChannel"`, [userId, type, channel]))[0]!.n);

test.describe.serial("notifications", () => {
  let f: Fx;
  let itemId: string;

  test.beforeAll(async () => {
    f = await newOrg();
    itemId = (await newSlaItem(f, "Checkout slow")).itemId;
  });
  test.afterAll(async () => {
    await cleanup(f);
    await closeDb();
  });

  test("the unread count, the inbox, reading one and reading all", async ({ page }) => {
    await notify(f, itemId, "sla_breach", "member");
    await notify(f, itemId, "review_ownership", "member");
    await signIn(page, f.emails.member);
    await expect(page.getByTestId("unread-count")).toHaveText("2");

    await page.getByTestId("nav-notifications").click();
    const list = page.getByTestId("notification");
    await expect(list).toHaveCount(2);
    await expect(list.filter({ hasText: 'Missed: acknowledge deadline on "Checkout slow"' })).toBeVisible();
    await expect(list.filter({ hasText: '"Checkout slow" needs an owner' })).toBeVisible();

    await list.filter({ hasText: "Missed:" }).getByRole("button", { name: "Mark read" }).click();
    await expect(page.getByText("Marked as read.")).toBeVisible();
    await expect(page.getByTestId("unread-count")).toHaveText("1");
    await expect(page.getByTestId("notification").filter({ hasText: "Missed:" })).toHaveAttribute("data-read", "true");

    await page.getByRole("button", { name: "Mark all as read" }).click();
    await expect(page.getByTestId("unread-count")).toHaveCount(0);
    expect(Number((await sql<{ n: string }>(`select count(*) as n from "Notification" where "recipientUserId" = $1 and "readAt" is null`, [f.users.member]))[0]!.n)).toBe(0);

    // A notification links to the work.
    await page.getByRole("link", { name: /needs an owner/ }).click();
    await expect(page).toHaveURL(new RegExp(`/items/${itemId}`));
  });

  test("someone else's notifications are not yours", async ({ page }) => {
    await notify(f, itemId, "sla_breach", "lead");
    await signIn(page, f.emails.member);
    await page.goto("/notifications");
    await expect(page.getByTestId("notification").filter({ hasText: "Missed:" })).toHaveCount(1); // only the member's own from before (now read)
    expect(await count(f.users.lead, "sla_breach")).toBe(1);
    await page.context().clearCookies();

    await signIn(page, f.emails.lead);
    await page.goto("/notifications");
    await expect(page.getByTestId("unread-count")).toHaveText("1");
    await expect(page.getByTestId("notification")).toHaveCount(1);
  });

  test("a setting that is turned off really stops that notification, and email is only recorded", async ({ page }) => {
    await signIn(page, f.emails.member);
    await page.goto("/notifications");
    const prefs = page.getByTestId("preferences");
    await expect(prefs.getByLabel("A deadline was missed: In the app")).toBeChecked(); // on by default
    await expect(prefs.getByLabel("A deadline was missed: Email")).not.toBeChecked(); // off by default
    await prefs.getByLabel("A deadline was missed: In the app").uncheck();
    await prefs.getByLabel("An item needs an owner: Email").check();
    await prefs.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Your notification settings were saved.")).toBeVisible();
    await expect(page.getByTestId("preferences").getByLabel("A deadline was missed: In the app")).not.toBeChecked(); // persisted

    const before = await count(f.users.member, "sla_breach");
    expect((await notify(f, itemId, "sla_breach", "member")).inApp).toBe(0); // opted out
    expect(await count(f.users.member, "sla_breach")).toBe(before);

    const r = await notify(f, itemId, "review_ownership", "member");
    expect(r).toEqual({ inApp: 1, email: 1 });
    const mail = await sql<{ deliveredAt: Date | null }>(`select "deliveredAt" from "Notification" where "recipientUserId" = $1 and channel = 'EMAIL'`, [f.users.member]);
    expect(mail).toEqual([{ deliveredAt: null }]); // recorded, never sent
  });
});
