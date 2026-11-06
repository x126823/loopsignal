import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { cleanup, closeDb, fakeGoogle, gmailSync, newOrg, signIn, sql, type Fx } from "./support";

/**
 * Sprint 12, in a real browser, against a FAKE Google Chat (no real space, no real credentials): an admin proves a space is theirs by
 * posting a one-time code in it, its messages become tracked items, a replying teammate counts as the team, and the space can be
 * removed. The app reads as one product-wide Chat app; nothing here is a per-customer secret.
 */
const newSpace = () => `spaces/E${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const REQUEST = "Our checkout page returns an error for all our customers right now. Can you look into this urgently?";
const sourceOf = async (organizationId: string, space: string) => (await sql<{ id: string }>(`select id from "MonitoredSource" where "organizationId" = $1 and "externalId" = $2`, [organizationId, space]))[0];

async function request(page: Page, space: string, team = "Support") {
  await page.goto("/settings/connections");
  await page.getByLabel("Space (name or link)").fill(space);
  await page.getByLabel("Team that handles this space").selectOption({ label: team });
  await page.getByRole("button", { name: "Request code" }).click();
  await expect(page.getByText(/Request created\./)).toBeVisible();
  return (await page.getByTestId("chat-claim").filter({ hasText: space }).getByTestId("chat-claim-code").textContent())!.trim();
}

test.describe.serial("google chat spaces", () => {
  let f: Fx;
  test.beforeAll(async () => {
    f = await newOrg();
  });
  test.afterAll(async () => {
    await cleanup(f);
    await closeDb();
  });

  test("an admin proves a space with a posted code, and its messages become tracked items", async ({ page }) => {
    const space = newSpace();
    await signIn(page, f.emails.admin);
    const code = await request(page, space);
    expect(code).toMatch(/^LS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const claim = page.getByTestId("chat-claim").filter({ hasText: space });

    // Not connected until the code is actually seen in the space, and the page says what is missing.
    await claim.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/cannot read that space/)).toBeVisible(); // the app has not been added yet
    expect(await sourceOf(f.organizationId, space)).toBeUndefined();

    await fakeGoogle("chat-membership", { space, member: true });
    await claim.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/code was not found/)).toBeVisible(); // added, but nobody posted the code yet

    await fakeGoogle("chat-add-message", { space, message: { text: `Connecting this space ${code}`, senderId: "users/900", senderName: "Admin Person" } });
    await claim.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText("Space connected.")).toBeVisible();
    const row = page.getByTestId("chat-space-row").filter({ hasText: space });
    await expect(row.getByTestId("chat-space-status")).toHaveText("Connected");
    await expect(row).toContainText("Support");
    await expect(page.getByTestId("chat-claim").filter({ hasText: space })).toHaveCount(0); // the request is used up
    const [audit] = await sql<{ n: string }>(`select count(*) n from "AuditLog" where "organizationId" = $1 and action = 'connection.chat_space_bound'`, [f.organizationId]);
    expect(Number(audit!.n)).toBeGreaterThanOrEqual(1);
    const src = (await sourceOf(f.organizationId, space))!;

    // Messages are read as the app (no per-customer secret exists), and a request becomes a tracked item, never a closed one.
    await fakeGoogle("chat-add-message", { space, message: { text: REQUEST, senderId: "users/501", senderName: "Pat Customer" } });
    const out = await gmailSync(f.organizationId, src.id);
    expect(out.summary).toMatchObject({ status: "SYNCED", messagesCreated: 2 });
    expect(out.statuses, JSON.stringify(out.reasons)).toContain("ITEM_CREATED");
    const [creds] = await sql<{ n: string }>(`select count(*) n from "ConnectionCredential" where "organizationId" = $1`, [f.organizationId]);
    expect(Number(creds!.n)).toBe(0);
    await page.goto("/items");
    await expect(page.getByRole("link", { name: "Chat message from Pat Customer" }).first()).toBeVisible();
    expect((await gmailSync(f.organizationId, src.id, false)).summary).toMatchObject({ status: "SYNCED", messagesCreated: 0 });
  });

  test("a teammate linked to a LoopSignal user counts as the team answering", async ({ page }) => {
    const space = newSpace();
    await signIn(page, f.emails.admin);
    const code = await request(page, space);
    await fakeGoogle("chat-membership", { space, member: true });
    await fakeGoogle("chat-add-message", { space, message: { text: code, senderId: "users/900", senderName: "Admin Person" } });
    await page.getByTestId("chat-claim").filter({ hasText: space }).getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText("Space connected.")).toBeVisible();
    const src = (await sourceOf(f.organizationId, space))!;
    const teammate = `users/${randomUUID().slice(0, 6)}`;
    await fakeGoogle("chat-add-message", { space, message: { text: REQUEST, senderId: "users/501", senderName: "Pat Customer" } });
    await fakeGoogle("chat-add-message", { space, message: { text: "Thanks, we have this and are looking into it.", senderId: teammate, senderName: "Casey Teammate" } });
    await gmailSync(f.organizationId, src.id, false);

    await page.goto("/settings/connections");
    const person = page.getByTestId("chat-person").filter({ hasText: "Casey Teammate" });
    await person.getByLabel("Team member for Casey Teammate").selectOption({ label: "Carol Member" });
    await person.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/Their future Chat messages count as your team's/)).toBeVisible();
    const [linked] = await sql<{ n: string }>(`select count(*) n from "Participant" where "organizationId" = $1 and address = $2 and "userId" = $3`, [f.organizationId, teammate, f.users.member]);
    expect(Number(linked!.n)).toBe(1);

    await fakeGoogle("chat-add-message", { space, message: { text: "The fix is deployed.", senderId: teammate, senderName: "Casey Teammate" } });
    await gmailSync(f.organizationId, src.id, false);
    const dirs = await sql<{ direction: string }>(`select m.direction from "Message" m join "Participant" p on p.id = m."senderParticipantId" where m."monitoredSourceId" = $1 and p.address = $2 order by m."sentAt"`, [src.id, teammate]);
    expect(dirs.map((d) => d.direction)).toEqual(["INBOUND", "OUTBOUND"]); // the earlier message keeps what it was
  });

  test("a space already connected elsewhere cannot be claimed, and removing it frees it", async ({ page }) => {
    const space = newSpace();
    const second = await newOrg();
    try {
      await signIn(page, f.emails.admin);
      const code = await request(page, space);
      await fakeGoogle("chat-membership", { space, member: true });
      await fakeGoogle("chat-add-message", { space, message: { text: code } });
      await page.getByTestId("chat-claim").filter({ hasText: space }).getByRole("button", { name: "Verify" }).click();
      await expect(page.getByText("Space connected.")).toBeVisible();

      await page.context().clearCookies();
      await signIn(page, second.emails.admin);
      const theirs = await request(page, space);
      await fakeGoogle("chat-add-message", { space, message: { text: theirs } });
      await page.getByTestId("chat-claim").filter({ hasText: space }).getByRole("button", { name: "Verify" }).click();
      await expect(page.getByText("That space is already connected.")).toBeVisible();
      expect(await sourceOf(second.organizationId, space)).toBeUndefined();
      await expect(page.getByTestId("chat-space-row")).toHaveCount(0); // nothing about the other organization is visible

      await page.context().clearCookies();
      await signIn(page, f.emails.admin);
      await page.goto("/settings/connections");
      await page.getByTestId("chat-space-row").filter({ hasText: space }).getByRole("button", { name: "Disconnect" }).click();
      await expect(page.getByText(/Space disconnected\./)).toBeVisible();
      await expect(page.getByTestId("chat-space-row").filter({ hasText: space }).getByTestId("chat-space-status")).toHaveText("Disconnected");

      await page.context().clearCookies();
      await signIn(page, second.emails.admin);
      await page.goto("/settings/connections");
      await page.getByTestId("chat-claim").filter({ hasText: space }).getByRole("button", { name: "Verify" }).click();
      await expect(page.getByText("Space connected.")).toBeVisible();
      expect(await sourceOf(second.organizationId, space)).toBeDefined();
    } finally {
      await cleanup(second);
    }
  });

  test("a space the app was removed from is skipped quietly and resumes when it is added back", async ({ page }) => {
    const space = newSpace();
    await signIn(page, f.emails.admin);
    const code = await request(page, space);
    await fakeGoogle("chat-membership", { space, member: true });
    await fakeGoogle("chat-add-message", { space, message: { text: code } });
    await page.getByTestId("chat-claim").filter({ hasText: space }).getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText("Space connected.")).toBeVisible();
    const src = (await sourceOf(f.organizationId, space))!;
    await gmailSync(f.organizationId, src.id, false);

    await fakeGoogle("chat-membership", { space, member: false });
    await fakeGoogle("chat-add-message", { space, message: { text: "Posted while the app was out." } });
    expect((await gmailSync(f.organizationId, src.id, false)).summary).toMatchObject({ status: "SKIPPED", reason: "SOURCE_UNAVAILABLE" });
    await fakeGoogle("chat-membership", { space, member: true });
    expect((await gmailSync(f.organizationId, src.id, false)).summary).toMatchObject({ status: "SYNCED", messagesCreated: 1 });
  });

  test("only organization admins can see or use any of it", async ({ page }) => {
    for (const who of ["lead", "member", "viewer"] as const) {
      await page.context().clearCookies();
      await signIn(page, f.emails[who]);
      await page.goto("/settings/connections");
      await expect(page.getByText("Only organization admins can manage connections.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Request code" })).toHaveCount(0);
      await expect(page.getByTestId("chat-claim")).toHaveCount(0);
    }
  });
});
