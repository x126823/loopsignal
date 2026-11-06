import { expect, test } from "@playwright/test";
import { auditVerify, cleanup, closeDb, newOrg, retentionDemo, signIn, sql, type Fx } from "./support";

/**
 * Sprint 13, in a real browser: an administrator sets how long content is kept (with guard rails against accidental data loss), sees what
 * the daily pass removed and whether the audit log checked out, and nobody else can.
 */
test.describe.serial("data retention", () => {
  let f: Fx;
  test.beforeAll(async () => {
    f = await newOrg();
  });
  test.afterAll(async () => {
    await cleanup(f);
    await closeDb();
  });

  test("an admin sees the defaults, changes the windows, and the change persists and is audited", async ({ page }) => {
    await signIn(page, f.emails.admin);
    await page.getByTestId("nav-retention").click();
    await expect(page.getByLabel("Raw provider payloads (days after receipt)")).toHaveValue("30");
    await expect(page.getByLabel("Message bodies and quotes (days)")).toHaveValue("180");

    await page.getByLabel("Raw provider payloads (days after receipt)").fill("14");
    await page.getByLabel("Message bodies and quotes (days)").fill("120");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Retention windows saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Raw provider payloads (days after receipt)")).toHaveValue("14");
    await expect(page.getByLabel("Message bodies and quotes (days)")).toHaveValue("120");
    const [audit] = await sql<{ n: string }>(`select count(*) n from "AuditLog" where "organizationId" = $1 and action = 'retention.settings_changed'`, [f.organizationId]);
    expect(Number(audit!.n)).toBe(1);
  });

  test("values that could lose data by accident are refused and change nothing", async ({ page }) => {
    await signIn(page, f.emails.admin);
    await page.goto("/settings/retention");
    // The browser's own min/max would stop most of these, so submit what a forged request could: bypass validation in the form.
    await page.evaluate(() => document.querySelector("#rawEventDays")!.closest("form")!.setAttribute("novalidate", "true"));
    for (const [raw, body] of [["200", "180"], ["3", "180"], ["30", "50"]] as const) {
      await page.getByLabel("Raw provider payloads (days after receipt)").fill(raw);
      await page.getByLabel("Message bodies and quotes (days)").fill(body);
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText(/Those windows are not allowed\./)).toBeVisible();
      await page.goto("/settings/retention");
      await page.evaluate(() => document.querySelector("#rawEventDays")!.closest("form")!.setAttribute("novalidate", "true"));
    }
    await expect(page.getByLabel("Raw provider payloads (days after receipt)")).toHaveValue("14"); // unchanged from the previous test
    const [audit] = await sql<{ n: string }>(`select count(*) n from "AuditLog" where "organizationId" = $1 and action = 'retention.settings_changed'`, [f.organizationId]);
    expect(Number(audit!.n)).toBe(1);
  });

  test("the status shows what the daily pass removed and that the audit log checked out", async ({ page }) => {
    await signIn(page, f.emails.admin);
    await page.goto("/settings/retention");
    await expect(page.getByTestId("last-purge")).toHaveText("Nothing has been removed yet.");
    await expect(page.getByTestId("last-verification")).toContainText("has not been checked yet");

    const out = await retentionDemo(f, 400); // an old message and raw payload, then one real retention pass
    expect(out).toMatchObject({ rawEvents: 1, messages: 1 });
    expect((await auditVerify()).broken).toBe(0);
    await page.reload();
    await expect(page.getByTestId("last-purge")).toContainText("1 raw payload, 1 message");
    await expect(page.getByTestId("last-verification")).toContainText("Audit log verified intact");
    await expect(page.getByTestId("anchor-status")).toContainText("anchors are off"); // honest about what the daily check cannot see without an anchor key
    const [gone] = await sql<{ n: string }>(`select count(*) n from "Message" where "organizationId" = $1 and "contentPurgedAt" is not null`, [f.organizationId]);
    expect(Number(gone!.n)).toBe(1);
  });

  test("only organization admins can see or change it", async ({ page }) => {
    for (const who of ["lead", "member", "viewer"] as const) {
      await page.context().clearCookies();
      await signIn(page, f.emails[who]);
      await expect(page.getByTestId("nav-retention")).toHaveCount(0);
      await page.goto("/settings/retention");
      await expect(page.getByText("Only organization admins can manage data retention.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    }
  });
});
