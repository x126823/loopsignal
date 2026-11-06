import { expect, test } from "@playwright/test";
import { cleanup, closeDb, newCandidate, newOrg, signIn, sql, type Fx } from "./support";

/**
 * Sprint 9, in a real browser: a message that looks like something we already track in another channel waits for a person.
 * Nothing is attached until they decide, deciding is two-step, and the database agrees with what the page says.
 */
const candidateRow = async (id: string) => (await sql<{ status: string; decidedBy: string | null; followUpAt: Date | null }>(`select status, "decidedBy", "followUpAt" from "CorrelationCandidate" where id = $1`, [id]))[0]!;
const links = (itemId: string, threadId: string) =>
  sql<{ role: string }>(`select l.role from "ItemMessageLink" l join "Message" m on m.id = l."messageId" where l."itemId" = $1 and m."threadId" = $2`, [itemId, threadId]);
const itemsOnThread = async (threadId: string) => Number((await sql<{ n: string }>(`select count(*) as n from "TrackedItem" where "threadId" = $1`, [threadId]))[0]!.n);

test.describe.serial("cross-channel candidates", () => {
  let f: Fx;
  test.beforeAll(async () => { f = await newOrg(); });
  test.afterAll(async () => { await cleanup(f); await closeDb(); });

  test("a person attaches the conversation; no second item appears, and it can be detached again", async ({ page }) => {
    const c = await newCandidate(f);
    expect(await itemsOnThread(c.chatThreadId)).toBe(0); // held for a person: no item was invented
    expect((await candidateRow(c.candidateId)).status).toBe("PENDING");

    await signIn(page, f.emails.member);
    await page.goto("/review");
    const card = page.getByTestId("correlation-candidate").filter({ hasText: "Checkout is broken" });
    await expect(card).toBeVisible();
    await expect(card.getByTestId("candidate-message")).toContainText("Order #48213 is stuck");
    await expect(card.getByTestId("candidate-signals")).toContainText("Reference numbers: 1 shared reference number");
    await expect(card.getByTestId("candidate-verdict")).toContainText("a suggestion only");

    // Two steps: the first click only reveals the form. Nothing changed yet.
    await card.getByText("Same matter: attach to this item").click();
    expect((await candidateRow(c.candidateId)).status).toBe("PENDING");
    await card.getByRole("button", { name: "Attach to this item" }).click();
    await expect(page.getByText("Attached. The conversation now belongs to that item.")).toBeVisible();

    const row = await candidateRow(c.candidateId);
    expect(row.status).toBe("CONFIRMED");
    expect(row.decidedBy).toBe(f.users.member);
    expect(await links(c.itemId, c.chatThreadId)).toEqual([{ role: "OTHER" }]);
    expect(await itemsOnThread(c.chatThreadId)).toBe(0);
    await expect(page.getByTestId("correlation-candidate").filter({ hasText: "Checkout is broken" })).toHaveCount(0); // decided: gone from the queue
    // No worker runs in this test, so the follow-up is still waiting and the page says so, with a retry.
    await expect(page.getByTestId("awaiting-follow-up")).toBeVisible();
    await page.getByRole("button", { name: "Retry follow-up" }).first().click();
    await expect(page.getByText("Follow-up queued.")).toBeVisible();

    // The item now shows the attached conversation.
    await page.goto(`/items/${c.itemId}`);
    const linked = page.getByTestId("linked-thread");
    await expect(linked).toContainText("From another channel");
    await expect(linked.getByTestId("linked-message")).toContainText("Order #48213 is stuck");

    // Detaching is also two-step, and undoes it because nothing was built on it.
    await linked.getByText("Not the same matter: detach this conversation").click();
    await linked.getByRole("button", { name: "Detach" }).click();
    await expect(page.getByText("Detached. The message will be tracked as its own item.")).toBeVisible();
    expect(await links(c.itemId, c.chatThreadId)).toEqual([]);
    expect((await candidateRow(c.candidateId)).status).toBe("REJECTED");
    await expect(page.getByTestId("linked-thread")).toHaveCount(0);
  });

  test("keeping them separate attaches nothing", async ({ page }) => {
    const c = await newCandidate(f);
    await signIn(page, f.emails.lead);
    await page.goto("/review");
    const card = page.getByTestId("correlation-candidate").filter({ hasText: "Checkout is broken" });
    await card.getByText("Different matter: keep separate").click();
    await card.getByRole("button", { name: "Keep separate" }).click();
    await expect(page.getByText("Kept separate. The message will be tracked as its own item.")).toBeVisible();
    expect((await candidateRow(c.candidateId)).status).toBe("REJECTED");
    expect(await links(c.itemId, c.chatThreadId)).toEqual([]);
  });

  test("an auditor can read the question but is offered no decision, and a person from another team sees nothing", async ({ page }) => {
    const c = await newCandidate(f);
    await signIn(page, f.emails.auditor);
    await page.goto("/review");
    const card = page.getByTestId("correlation-candidate").filter({ hasText: "Checkout is broken" });
    await expect(card).toContainText("You can view this question but not decide it.");
    await expect(card.getByRole("button", { name: "Attach to this item" })).toHaveCount(0);
    expect((await candidateRow(c.candidateId)).status).toBe("PENDING");
  });

  test("a person from another team cannot see the question or the message", async ({ page }) => {
    await newCandidate(f);
    await signIn(page, f.emails.otherTeamMember);
    await page.goto("/review");
    await expect(page.getByText("Checkout is broken")).toHaveCount(0);
    await expect(page.getByTestId("correlation-candidate")).toHaveCount(0);
  });
});
