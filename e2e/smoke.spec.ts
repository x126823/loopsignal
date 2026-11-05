import { expect, test } from "@playwright/test";

test("the sign-in page renders", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "LoopSignal" })).toBeVisible();
});

test("unauthenticated visitors are sent to sign in, from every protected page", async ({ page }) => {
  for (const path of ["/", "/approvals", "/items", "/review"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/login/);
  }
});
