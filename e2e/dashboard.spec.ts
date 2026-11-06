import { expect, test } from "@playwright/test";
import { cleanup, closeDb, newOrg, newSlaItem, signIn, type Fx } from "./support";

/**
 * Sprint 10, in a real browser: the dashboard shows the four metrics separately, derived from events and scoped to what the person
 * may see, and the item page tells the whole story in one timeline. Items are dated October 2026 and the page reads the real clock,
 * so a 365-day window includes them and anything still open is long overdue.
 */
test.describe.serial("dashboard and timeline", () => {
  let f: Fx;
  let other: Fx;
  let answered: string;
  let silent: string;

  test.beforeAll(async () => {
    f = await newOrg();
    other = await newOrg();
    answered = (await newSlaItem(f, "Answered quickly", { replied: true })).itemId;
    silent = (await newSlaItem(f, "Nobody answered")).itemId;
  });
  test.afterAll(async () => {
    await cleanup(f, other);
    await closeDb();
  });

  test("the four metrics are separate, and an early reply meets the deadline without being an acknowledgment", async ({ page }) => {
    await signIn(page, f.emails.member);
    await page.goto("/dashboard?days=365");
    await expect(page.getByText("2 items received in the last 365 days")).toBeVisible();

    // One item was answered 20 minutes in (a substantive response, with no separate acknowledgment); one was never answered.
    await expect(page.getByTestId("achieved-response")).toHaveText("1");
    await expect(page.getByTestId("pending-response")).toHaveText("1");
    await expect(page.getByTestId("median-response")).toHaveText("20m");
    await expect(page.getByTestId("achieved-acknowledgment")).toHaveText("0"); // a response is not an acknowledgment
    await expect(page.getByTestId("pending-acknowledgment")).toHaveText("2");
    await expect(page.getByTestId("achieved-resolution")).toHaveText("0");
    await expect(page.getByTestId("achieved-closure")).toHaveText("0");

    // A substantive reply in time meets the acknowledgment deadline; the silent item missed it: 1 of 2 kept.
    await expect(page.getByTestId("sla-row-ack")).toContainText("50%");
    await expect(page.getByTestId("sla-row-response")).toContainText("50%");

    // The silent item needs attention, and links to the item.
    const row = page.getByTestId("attention-row").filter({ hasText: "Nobody answered" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Acknowledge");
    await expect(page.getByTestId("attention-row").filter({ hasText: "Answered quickly" })).toBeVisible(); // its resolve and close deadlines passed
    await row.getByRole("link", { name: "Nobody answered" }).click();
    await expect(page).toHaveURL(new RegExp(`/items/${silent}`));
  });

  test("the item page shows one timeline: messages, changes and missed deadlines in order", async ({ page }) => {
    await signIn(page, f.emails.member);
    await page.goto(`/items/${answered}`);
    const timeline = page.getByTestId("timeline");
    await expect(timeline.getByTestId("timeline-message")).toHaveCount(2); // the request and our reply
    await expect(timeline.getByTestId("event").filter({ hasText: "Responded" })).toHaveCount(1);
    await expect(timeline.getByTestId("timeline-deadline").filter({ hasText: "Deadline missed: Resolve" })).toHaveCount(1);
    await expect(timeline.getByTestId("timeline-deadline").filter({ hasText: "Deadline missed: Acknowledge" })).toHaveCount(0); // it was met

    await page.goto(`/items/${silent}`);
    await expect(page.getByTestId("timeline").getByTestId("timeline-deadline").filter({ hasText: "Deadline missed: Acknowledge" })).toHaveCount(1);
    // The timeline carries no message text: that stays in the conversation card.
    await expect(page.getByTestId("timeline")).not.toContainText("checkout page returns an error");
  });

  test("people see only what they may: a viewer sees the team, another organization sees nothing of it", async ({ page }) => {
    await signIn(page, f.emails.viewer);
    await page.goto("/dashboard?days=365");
    await expect(page.getByText("2 items received")).toBeVisible();
    await page.context().clearCookies();

    await signIn(page, f.emails.otherTeamMember); // a member of a different team in the same organization
    await page.goto("/dashboard?days=365");
    await expect(page.getByText("0 items received")).toBeVisible();
    await expect(page.getByText("No items in this period.")).toBeVisible();
    await expect(page.getByText("Nobody answered")).toHaveCount(0);
    await page.context().clearCookies();

    await signIn(page, other.emails.admin);
    await page.goto("/dashboard?days=365");
    await expect(page.getByText("0 items received")).toBeVisible();
    await expect(page.getByText("Nobody answered")).toHaveCount(0);
  });

  test("a team filter that is not yours shows nothing and gives no hint it exists", async ({ page }) => {
    await signIn(page, f.emails.lead);
    await page.goto(`/dashboard?days=365&team=${f.teamId}`);
    await expect(page.getByText("2 items received")).toBeVisible();
    await page.goto("/dashboard?days=365&team=00000000-0000-4000-8000-000000000000");
    await expect(page.getByText("0 items received")).toBeVisible();
  });
});
