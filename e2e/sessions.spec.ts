import { expect, test } from "@playwright/test";
import { cleanup, closeDb, newOrg, signIn, sql, type Fx } from "./support";

/**
 * Security gap O4, in a real browser with several "devices" (separate browser contexts, each with its own cookies): a stolen or forgotten
 * session can be ended by its owner, or by an administrator, and the person can sign in again at once.
 */
test.describe.serial("ending sessions", () => {
  let f: Fx;
  test.beforeAll(async () => {
    f = await newOrg();
  });
  test.afterAll(async () => {
    await cleanup(f);
    await closeDb();
  });

  test("signing out everywhere ends the session on every device, and signing in again works immediately", async ({ browser }) => {
    const laptop = await browser.newContext();
    const phone = await browser.newContext();
    const lp = await laptop.newPage();
    const ph = await phone.newPage();
    await signIn(lp, f.emails.member);
    await signIn(ph, f.emails.member);
    await ph.goto("/dashboard");
    await expect(ph.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    await lp.getByTestId("nav-security").click();
    await lp.getByRole("button", { name: "Sign out everywhere" }).first().click();
    await lp.waitForURL(/\/login/);

    // The phone never pressed anything, and is signed out on its very next request.
    await ph.goto("/dashboard");
    await expect(ph).toHaveURL(/\/login/);
    await lp.goto("/approvals");
    await expect(lp).toHaveURL(/\/login/);
    const [audit] = await sql<{ n: string }>(`select count(*) n from "AuditLog" where "organizationId" = $1 and action = 'session.revoked_self' and "actorId" = $2`, [f.organizationId, f.users.member]);
    expect(Number(audit!.n)).toBe(1);

    // And there is no lock-out: a fresh sign-in straight afterwards is a valid session.
    await signIn(lp, f.emails.member);
    await lp.goto("/dashboard");
    await expect(lp.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await laptop.close();
    await phone.close();
  });

  test("an administrator can end a member's sessions, and nobody else can", async ({ browser }) => {
    const adminCtx = await browser.newContext();
    const memberCtx = await browser.newContext();
    const leadCtx = await browser.newContext();
    const [admin, member, lead] = await Promise.all([adminCtx.newPage(), memberCtx.newPage(), leadCtx.newPage()]);
    await signIn(admin, f.emails.admin);
    await signIn(member, f.emails.member);
    await signIn(lead, f.emails.lead);

    // A lead sees the self-service card but no list of members to act on.
    await lead.goto("/settings/security");
    await expect(lead.getByRole("heading", { name: "Sign out everywhere" })).toBeVisible();
    await expect(lead.getByTestId("member-row")).toHaveCount(0);

    await admin.goto("/settings/security");
    const row = admin.getByTestId("member-row").filter({ hasText: "Carol Member" });
    await row.getByRole("button", { name: "Sign out everywhere" }).click();
    await expect(admin.getByText(/Signed out everywhere\./)).toBeVisible();

    await member.goto("/dashboard");
    await expect(member).toHaveURL(/\/login/); // ended
    await lead.goto("/dashboard");
    await expect(lead.getByRole("heading", { name: "Dashboard" })).toBeVisible(); // untouched
    await admin.goto("/dashboard");
    await expect(admin.getByRole("heading", { name: "Dashboard" })).toBeVisible(); // the administrator's own session is not ended by ending someone else's
    const [audit] = await sql<{ n: string }>(`select count(*) n from "AuditLog" where "organizationId" = $1 and action = 'session.revoked' and "actorId" = $2 and "entityId" = $3`, [f.organizationId, f.users.admin, f.users.member]);
    expect(Number(audit!.n)).toBe(1);
    await Promise.all([adminCtx.close(), memberCtx.close(), leadCtx.close()]);
  });
});
