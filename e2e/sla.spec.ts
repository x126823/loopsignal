import { expect, test } from "@playwright/test";
import { cleanup, closeDb, newOrg, newSlaItem, signIn, sql, type Fx } from "./support";

/**
 * Sprint 8, in a real browser: an item page shows its four deadlines, built by the SLA engine from the item's events.
 * Items are dated October 2026 and the page reads the real clock, so anything still open there is long overdue.
 * Timer states are checked in the database too: the page only displays them.
 */
test.describe.serial("SLA deadlines on the item page", () => {
  let f: Fx;
  let other: Fx;

  test.beforeAll(async () => {
    f = await newOrg();
    other = await newOrg();
  });
  test.afterAll(async () => {
    await cleanup(f, other);
    await closeDb();
  });

  test("a prompt reply meets the early deadlines while unfinished ones show as overdue", async ({ page }) => {
    const { itemId } = await newSlaItem(f, "Checkout slow", { replied: true });
    await signIn(page, f.emails.member);
    await page.goto(`/items/${itemId}`);

    const timers = page.getByTestId("sla-timers");
    await expect(timers).toBeVisible();
    await expect(page.getByTestId("sla-ack")).toContainText("Met");
    await expect(page.getByTestId("sla-response")).toContainText("Met");
    await expect(page.getByTestId("sla-resolve")).toContainText("Overdue");
    await expect(page.getByTestId("sla-close")).toContainText("Overdue");

    // The stored rows agree for the settled timers, and no deadline was invented for the page.
    const rows = await sql<{ type: string; state: string }>(`select type, state from "SlaTimer" where "itemId" = $1 order by type`, [itemId]);
    expect(Object.fromEntries(rows.map((r) => [r.type, r.state]))).toMatchObject({ ACK: "MET", RESPONSE: "MET" });
    // The AI risk hint only appears while something is due soon, so it is absent here.
    await expect(page.getByTestId("sla-risk")).toHaveCount(0);
  });

  test("an unanswered item shows every deadline as overdue", async ({ page }) => {
    const { itemId } = await newSlaItem(f, "Nobody answered");
    await signIn(page, f.emails.member);
    await page.goto(`/items/${itemId}`);
    for (const t of ["ack", "response", "resolve", "close"]) await expect(page.getByTestId(`sla-${t}`)).toContainText("Overdue");
  });

  test("another organization's member cannot see the item or its deadlines", async ({ page }) => {
    const { itemId } = await newSlaItem(f, "Private to the first org");
    await signIn(page, other.emails.member);
    const res = await page.goto(`/items/${itemId}`);
    expect(res?.status()).toBe(404);
    await expect(page.getByTestId("sla-timers")).toHaveCount(0);
  });
});
