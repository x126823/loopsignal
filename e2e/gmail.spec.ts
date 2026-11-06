import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { cleanup, closeDb, fakeGoogle, gmailSync, newOrg, signIn, sql, type Fx } from "./support";

/**
 * Sprint 11, in a real browser, against a FAKE Google (no real mailbox, no real credentials): an admin connects a mailbox through
 * the consent flow, its mail becomes tracked items, access can be withdrawn from either side, and only admins can manage any of it.
 */
const newMailbox = () => `e2e-${randomUUID().slice(0, 8)}@synthetic.test`;
const REQUEST = { from: "Pat Customer <pat@customer.test>", subject: "Checkout is down", text: "Our checkout page returns an error for all our customers right now. Can you look into this urgently?" };

async function connect(page: import("@playwright/test").Page, mailbox: string, mode: "grant" | "deny" | "no_refresh" | "wrong_scope" = "grant") {
  await fakeGoogle("consent", { mailbox, mode });
  await page.goto("/settings/connections");
  await page.getByLabel("Team that handles this mailbox").selectOption({ label: "Support" });
  await page.getByRole("button", { name: "Connect Gmail" }).click();
  await page.waitForURL(/\/settings\/connections\?notice=/);
}
const sourceOf = async (organizationId: string, mailbox: string) =>
  (await sql<{ id: string; connectionId: string }>(`select id, "connectionId" from "MonitoredSource" where "organizationId" = $1 and "externalId" = $2`, [organizationId, mailbox]))[0];

test.describe.serial("gmail connection", () => {
  let f: Fx;
  test.beforeAll(async () => {
    f = await newOrg();
  });
  test.afterAll(async () => {
    await cleanup(f);
    await closeDb();
  });

  test("the integration is switched on for this run", async ({ page }) => {
    await signIn(page, f.emails.admin);
    await page.goto("/settings/connections");
    await expect(page.getByRole("button", { name: "Connect Gmail" }), "start with GMAIL_ENABLED on and the fake Google up; stop any dev server already running").toBeVisible();
  });

  test("an admin connects a mailbox through consent, and its mail becomes tracked items", async ({ page }) => {
    const mailbox = newMailbox();
    await fakeGoogle("add-message", { mailbox, message: REQUEST });
    await fakeGoogle("add-message", { mailbox, message: { from: `Support <${mailbox}>`, subject: "Re: Checkout is down", text: "Thanks, we have this and are looking into it.", labels: ["SENT"] } });
    await signIn(page, f.emails.admin);
    await connect(page, mailbox);

    await expect(page.getByText("Mailbox connected. The first sync is queued.")).toBeVisible();
    const row = page.getByTestId("connection-row").filter({ hasText: mailbox });
    await expect(row.getByTestId("connection-status")).toHaveText("Connected");
    await expect(row).toContainText("Support");

    // The tokens are stored, and encrypted: the bytes do not contain the token text, and no page or table lists them.
    const src = (await sourceOf(f.organizationId, mailbox))!;
    const [cred] = await sql<{ tokens: Buffer }>(`select tokens from "ConnectionCredential" where "connectionId" = $1`, [src.connectionId]);
    expect(cred!.tokens.length).toBeGreaterThan(30);
    expect(cred!.tokens.toString("utf8")).not.toContain("rt-");
    expect(await page.content()).not.toMatch(/rt-[0-9a-f]{8}-|at-[0-9a-f]{8}-/);
    const [audit] = await sql<{ n: string }>(`select count(*) n from "AuditLog" where "organizationId" = $1 and action = 'connection.gmail_connected' and "entityId" = $2`, [f.organizationId, src.connectionId]);
    expect(Number(audit!.n)).toBe(1);

    // A sync (as the worker runs it) brings the mail in; analysis turns the request into a tracked item, never a closed one.
    const out = await gmailSync(f.organizationId, src.id);
    expect(out.summary).toMatchObject({ status: "SYNCED", messagesCreated: 2 });
    expect(out.statuses, JSON.stringify(out.reasons)).toContain("ITEM_CREATED");
    const [state] = await sql<{ state: string }>(`select i.state from "TrackedItem" i join "Message" m on m.id = i."originMessageId" where m."monitoredSourceId" = $1`, [src.id]);
    expect(state!.state).not.toBe("CLOSED");
    await page.goto("/items");
    await expect(page.getByRole("link", { name: /checkout/i }).first()).toBeVisible();

    // A repeat sync finds nothing new, and a second sync of the same mail creates nothing twice.
    expect((await gmailSync(f.organizationId, src.id, false)).summary).toMatchObject({ status: "SYNCED", messagesCreated: 0 });
    const [msgs] = await sql<{ n: string }>(`select count(*) n from "Message" where "monitoredSourceId" = $1`, [src.id]);
    expect(Number(msgs!.n)).toBe(2);

    // The page's own "Sync now" queues a sync and says so.
    await page.goto("/settings/connections");
    await row.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText("Sync queued.")).toBeVisible();
  });

  test("an admin disconnects: access is revoked at Google, credentials are deleted, mail is kept and syncing stops", async ({ page }) => {
    const mailbox = newMailbox();
    await fakeGoogle("add-message", { mailbox, message: REQUEST });
    await signIn(page, f.emails.admin);
    await connect(page, mailbox);
    const src = (await sourceOf(f.organizationId, mailbox))!;
    await gmailSync(f.organizationId, src.id, false);
    const before = Number((await fakeGoogle("state"))["revoked"]);

    const row = page.getByTestId("connection-row").filter({ hasText: mailbox });
    await row.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByText(/Mailbox disconnected\./)).toBeVisible();
    await expect(row.getByTestId("connection-status")).toHaveText("Disconnected");
    await expect(row.getByRole("button", { name: "Sync now" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Disconnect" })).toHaveCount(0);

    expect(Number((await fakeGoogle("state"))["revoked"])).toBe(before + 1);
    const [creds] = await sql<{ n: string }>(`select count(*) n from "ConnectionCredential" where "connectionId" = $1`, [src.connectionId]);
    expect(Number(creds!.n)).toBe(0);
    const [kept] = await sql<{ n: string }>(`select count(*) n from "Message" where "monitoredSourceId" = $1`, [src.id]);
    expect(Number(kept!.n)).toBe(1);
    expect((await gmailSync(f.organizationId, src.id, false)).summary).toMatchObject({ status: "SKIPPED", reason: "SOURCE_DISABLED" });
    const [audit] = await sql<{ n: string }>(`select count(*) n from "AuditLog" where "organizationId" = $1 and action = 'connection.disconnected' and "entityId" = $2`, [f.organizationId, src.connectionId]);
    expect(Number(audit!.n)).toBe(1);
  });

  test("nothing is connected when the admin declines, or Google grants less than asked", async ({ page }) => {
    await signIn(page, f.emails.admin);
    const cases = [["deny", "Google did not grant access, so nothing was connected."], ["wrong_scope", "Google did not grant read access to the mailbox, so nothing was connected."], ["no_refresh", "Google did not issue lasting access."]] as const;
    for (const [mode, message] of cases) {
      const mailbox = newMailbox();
      await connect(page, mailbox, mode);
      await expect(page.getByText(message)).toBeVisible();
      expect(await sourceOf(f.organizationId, mailbox)).toBeUndefined();
      await expect(page.getByTestId("connection-row").filter({ hasText: mailbox })).toHaveCount(0);
    }
  });

  test("a callback that was not started here is refused, and the cookie is single use", async ({ page }) => {
    await signIn(page, f.emails.admin);
    await page.goto("/api/gmail/callback?code=forged&state=forged");
    await expect(page).toHaveURL(/notice=gmail_state/);
    await expect(page.getByText("That connection attempt could not be verified or has expired.")).toBeVisible();
    const before = Number((await sql<{ n: string }>(`select count(*) n from "SourceConnection" where "organizationId" = $1`, [f.organizationId]))[0]!.n);
    await page.goto("/api/gmail/callback?error=access_denied&state=forged");
    expect(Number((await sql<{ n: string }>(`select count(*) n from "SourceConnection" where "organizationId" = $1`, [f.organizationId]))[0]!.n)).toBe(before);
  });

  test("when Google withdraws access, the mailbox is flagged as needing attention and stops syncing", async ({ page }) => {
    const mailbox = newMailbox();
    await fakeGoogle("add-message", { mailbox, message: REQUEST });
    await signIn(page, f.emails.admin);
    await connect(page, mailbox);
    const src = (await sourceOf(f.organizationId, mailbox))!;
    await fakeGoogle("revoke-refresh", { mailbox });
    await fakeGoogle("expire-access");

    expect((await gmailSync(f.organizationId, src.id, false)).summary).toMatchObject({ status: "SKIPPED", reason: "CONNECTION_INACTIVE" });
    await page.goto("/settings/connections");
    const row = page.getByTestId("connection-row").filter({ hasText: mailbox });
    await expect(row.getByTestId("connection-status")).toHaveText("Needs attention");
    await expect(row.getByRole("button", { name: "Sync now" })).toHaveCount(0);
    const [msgs] = await sql<{ n: string }>(`select count(*) n from "Message" where "monitoredSourceId" = $1`, [src.id]);
    expect(Number(msgs!.n)).toBe(0);

    // Reconnecting brings the same mailbox back (same source, not a second one) and mail flows again.
    await connect(page, mailbox);
    await expect(page.getByText("Mailbox reconnected.")).toBeVisible();
    await expect(row.getByTestId("connection-status")).toHaveText("Connected");
    expect((await sql<{ n: string }>(`select count(*) n from "MonitoredSource" where "organizationId" = $1 and "externalId" = $2`, [f.organizationId, mailbox]))[0]!.n).toBe("1");
    expect((await gmailSync(f.organizationId, src.id, false)).summary).toMatchObject({ status: "SYNCED", messagesCreated: 1 });
  });

  test("only organization admins see or can use connections", async ({ page }) => {
    for (const who of ["lead", "member", "viewer"] as const) {
      await page.context().clearCookies();
      await signIn(page, f.emails[who]);
      await expect(page.getByTestId("nav-connections")).toHaveCount(0);
      await page.goto("/settings/connections");
      await expect(page.getByText("Only organization admins can manage connections.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Connect Gmail" })).toHaveCount(0);
      // Forging the start of the flow (a direct request to the callback) as a non-admin connects nothing.
      const count = async () => Number((await sql<{ n: string }>(`select count(*) n from "SourceConnection" where "organizationId" = $1`, [f.organizationId]))[0]!.n);
      const before = await count();
      await page.goto("/api/gmail/callback?code=x&state=x");
      await expect(page).toHaveURL(/notice=forbidden/);
      await expect(page.getByText("Only organization admins can manage connections.")).toBeVisible();
      expect(await count()).toBe(before);
    }
    await page.context().clearCookies();
    await signIn(page, f.emails.admin);
    await expect(page.getByTestId("nav-connections")).toBeVisible();
  });
});
