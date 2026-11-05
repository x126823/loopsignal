import { expect, test } from "@playwright/test";
import { bumpVersion, cleanup, closeDb, decisionEvents, humanMove, newItem, newOrg, queueReview, setOrgSettings, signIn, sql, stateOf, type Fx } from "./support";

/**
 * Sprint 7 exit criterion, in a real browser: proposal -> human confirm -> human close, and nothing happens without a person.
 * Each test builds its own synthetic organization through the lifecycle engine, signs in with the dev provider, and checks
 * the database as well as the page.
 */
const emailOf = (f: Fx, who: keyof Fx["emails"]) => f.emails[who];

test.describe.serial("human decisions", () => {
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

  test("proposal -> human confirms -> human closes, and neither happens by itself", async ({ page }) => {
    const { itemId } = await newItem(f, "Checkout outage", { state: "RESOLUTION_PROPOSED", suggestConfirmation: true });

    // The system has suggested a confirmation. Nothing has been decided, and no amount of waiting changes that.
    expect(await stateOf(itemId)).toBe("RESOLUTION_PROPOSED");
    expect(await decisionEvents(itemId)).toHaveLength(0);

    await signIn(page, emailOf(f, "member"));
    await expect(page.getByRole("link", { name: "Checkout outage" })).toBeVisible(); // it is waiting on the approvals page
    await page.getByRole("link", { name: "Checkout outage" }).click();

    await expect(page.getByRole("heading", { name: "Checkout outage" })).toBeVisible();
    await expect(page.getByText("Resolution proposed").first()).toBeVisible();
    await expect(page.getByTestId("metric-resolved")).toHaveText("—"); // a proposal is not a resolution
    await expect(page.getByTestId("metric-closed")).toHaveText("—");
    const approval = page.getByTestId("pending-approval");
    await expect(approval).toContainText("Suggested: Confirm resolution");
    await expect(approval).toContainText("Works now"); // the quoted evidence the AI relied on
    await expect(page.getByTestId("message").first()).toContainText("checkout page returns an error"); // the real conversation is visible to approvers

    // Step 1: a person approves. The first click only opens the form.
    await approval.getByText("Approve this request").click();
    await approval.getByLabel("Note (optional)").first().fill("Customer confirmed by email");
    await approval.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("Approved. The change was recorded.")).toBeVisible();
    await expect(page.getByText("Resolution confirmed").first()).toBeVisible();
    await expect(page.getByTestId("metric-resolved")).not.toHaveText("—"); // confirmed...
    await expect(page.getByTestId("metric-closed")).toHaveText("—"); // ...is not closed
    expect(await stateOf(itemId)).toBe("RESOLUTION_CONFIRMED");

    // Step 2: a person closes, as a separate decision.
    await page.getByText("Close item", { exact: true }).first().click();
    await page.getByRole("button", { name: "Close item" }).last().click();
    await expect(page.getByText("Done. The change was recorded.")).toBeVisible();
    await expect(page.getByTestId("metric-closed")).not.toHaveText("—");
    expect(await stateOf(itemId)).toBe("CLOSED");

    // Both decisions are on record as Carol's, a person's, with the note she wrote.
    const events = await decisionEvents(itemId);
    expect(events.map((e) => [e.toState, e.actorType, e.actorId])).toEqual([["RESOLUTION_CONFIRMED", "USER", f.users.member], ["CLOSED", "USER", f.users.member]]);
    expect(events[0]!.reason).toBe("Customer confirmed by email");
    await expect(page.getByTestId("event").filter({ hasText: "Carol Member" })).toHaveCount(2);
    const approved = await sql<{ n: string }>(`select count(*) n from "ApprovalRequest" where "itemId" = $1 and status = 'APPROVED' and "decidedBy" = $2`, [itemId, f.users.member]);
    expect(Number(approved[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  test("a rejected proposal goes back to work", async ({ page }) => {
    const { itemId } = await newItem(f, "Proposal to reject", { state: "RESOLUTION_PROPOSED" });
    await signIn(page, emailOf(f, "lead"));
    await page.goto(`/items/${itemId}`);
    await page.getByText("Reject proposal", { exact: true }).first().click();
    await page.getByLabel(/Why is the proposal rejected/).fill("Customer says it is still failing");
    await page.getByRole("button", { name: "Reject proposal" }).last().click();
    await expect(page.getByText("In progress").first()).toBeVisible();
    expect(await stateOf(itemId)).toBe("IN_PROGRESS");
  });

  test("a viewer can read an item but is offered no decisions", async ({ page }) => {
    const { itemId } = await newItem(f, "Viewer sees this", { state: "RESOLUTION_PROPOSED", suggestConfirmation: true });
    await signIn(page, emailOf(f, "viewer"));
    await page.goto(`/items/${itemId}`);
    await expect(page.getByRole("heading", { name: "Viewer sees this" })).toBeVisible();
    await expect(page.getByTestId("message").first()).toBeVisible();
    // They can see that a decision is pending, but get no way to make it.
    await expect(page.getByTestId("pending-approval")).toContainText("You can view this request but not decide it.");
    await expect(page.getByRole("button", { name: /Approve|Reject|Confirm|Close|Reopen/ })).toHaveCount(0);
    await expect(page.getByText(/Approve this request|Reject this request|Close item|Reopen item/)).toHaveCount(0);
    await expect(page.getByLabel("Assign owner")).toHaveCount(0);
    expect(await stateOf(itemId)).toBe("RESOLUTION_PROPOSED");
  });

  test("editing a form cannot get around the server: a member cannot confirm when the organization requires a lead", async ({ page }) => {
    await setOrgSettings(f.organizationId, { lifecycle: { approvalMinRole: "TEAM_LEAD" } });
    try {
      const { itemId } = await newItem(f, "Tamper target", { state: "RESOLUTION_PROPOSED" });
      await signIn(page, emailOf(f, "member"));
      await page.goto(`/items/${itemId}`);
      await expect(page.getByText("Confirm resolution", { exact: true })).toHaveCount(0); // not offered at this role...
      const reject = page.locator("details", { hasText: "Reject proposal" }).first();
      await reject.locator("summary").click();
      // ...so a person edits the allowed "Reject proposal" form to say CONFIRM instead, then submits it for real.
      await reject.locator('input[name="to"]').evaluate((el) => ((el as HTMLInputElement).value = "RESOLUTION_CONFIRMED"));
      await reject.getByRole("button", { name: "Reject proposal" }).click();
      await expect(page.getByText("You do not have permission to do that.")).toBeVisible();
      expect(await stateOf(itemId)).toBe("RESOLUTION_PROPOSED");
      expect(await decisionEvents(itemId)).toHaveLength(0);
    } finally {
      await setOrgSettings(f.organizationId, {});
    }
  });

  test("a form that went stale is refused rather than overwriting newer work", async ({ page }) => {
    const { itemId } = await newItem(f, "Goes stale", { state: "RESPONDED" });
    await signIn(page, emailOf(f, "member"));
    await page.goto(`/items/${itemId}`);
    const propose = page.locator("details", { hasText: "Propose resolution" }).first();
    await propose.locator("summary").click();
    // While the form is open, someone else moves the item on.
    await bumpVersion(itemId);
    await propose.getByRole("button", { name: "Propose resolution" }).click();
    await expect(page.getByText(/changed while you were looking/)).toBeVisible();
    expect(await stateOf(itemId)).toBe("RESPONDED");
  });

  test("another organization's item cannot be opened, and gives no hint that it exists", async ({ page }) => {
    const theirs = await newItem(other, "Someone else's secret", { state: "RESOLUTION_PROPOSED" });
    await signIn(page, emailOf(f, "admin"));
    const response = await page.goto(`/items/${theirs.itemId}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByText("Someone else's secret")).toHaveCount(0);
    await page.goto("/items?view=all");
    await expect(page.getByText("Someone else's secret")).toHaveCount(0);
  });

  test("a person can work the review queue and assign an owner", async ({ page }) => {
    const { itemId } = await newItem(f, "Needs an owner");
    await queueReview(f, "OWNERSHIP", itemId);
    await signIn(page, emailOf(f, "lead"));
    await page.goto("/review");
    const row = page.getByRole("row", { name: /Needs an owner/ });
    await expect(row).toContainText("Needs an owner");

    await row.getByRole("link", { name: "Needs an owner" }).click();
    await page.getByLabel("Assign owner").selectOption({ label: "Carol Member" });
    await page.getByRole("button", { name: "Save owner" }).click();
    await expect(page.getByText("Owner updated.")).toBeVisible();
    expect((await sql<{ ownerUserId: string }>(`select "ownerUserId" from "TrackedItem" where id = $1`, [itemId]))[0]!.ownerUserId).toBe(f.users.member);

    await page.goto("/review"); // assigning an owner closed the task
    await expect(page.getByRole("row", { name: /Needs an owner/ })).toHaveCount(0);
  });

  test("review tasks can be resolved by a person, and viewers do not get the controls", async ({ page }) => {
    const { itemId } = await newItem(f, "Low confidence one");
    await queueReview(f, "LOW_CONFIDENCE", itemId);
    await signIn(page, emailOf(f, "member"));
    await page.goto("/review");
    const row = page.getByRole("row", { name: /Low confidence one/ });
    await row.getByPlaceholder("Note (optional)").fill("Checked, looks right");
    await row.getByRole("button", { name: "Resolve" }).click();
    await expect(page.getByText("Review task resolved.")).toBeVisible();
    const [task] = await sql<{ status: string; resolution: string }>(`select status, resolution from "ReviewTask" where "refId" = $1 and type = 'LOW_CONFIDENCE'`, [itemId]);
    expect([task!.status, task!.resolution]).toEqual(["RESOLVED", "Checked, looks right"]);
    await page.context().clearCookies();

    const second = await newItem(f, "Viewer cannot resolve");
    await queueReview(f, "LOW_CONFIDENCE", second.itemId);
    await signIn(page, emailOf(f, "viewer"));
    await page.goto("/review");
    await expect(page.getByRole("button", { name: "Resolve" })).toHaveCount(0);
    await expect(page.getByText("Nothing to review.")).toBeVisible(); // the queue is not shown to viewers at all
  });

  test("items are listed by what the person may see", async ({ page }) => {
    const { itemId } = await newItem(f, "Closed long ago", { state: "RESOLUTION_PROPOSED" });
    await humanMove(f, itemId, "RESOLUTION_CONFIRMED");
    await humanMove(f, itemId, "CLOSED");
    await signIn(page, emailOf(f, "member"));
    await page.goto("/items");
    await expect(page.getByRole("link", { name: "Closed long ago" })).toHaveCount(0); // "Open" is the default view
    await page.getByRole("link", { name: "Closed", exact: true }).click();
    await expect(page.getByRole("link", { name: "Closed long ago" })).toBeVisible();
  });
});
