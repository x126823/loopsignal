import { expect, test } from "@playwright/test";
import { cleanup, closeDb, newItem, newOrg, signIn, type Fx } from "./support";

/**
 * Sprint 13, in a real browser: the security headers are on every response, the nonce-based content security policy lets the app run
 * with nothing blocked, and hostile text in a title is shown as text and never executes.
 */
const PAGES = ["/approvals", "/dashboard", "/items", "/review", "/notifications", "/settings/connections", "/settings/retention"];
const XSS_TITLE = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>`;

test.describe.serial("browser-side security", () => {
  let f: Fx;
  let itemId: string;
  test.beforeAll(async () => {
    f = await newOrg();
    itemId = (await newItem(f, XSS_TITLE)).itemId;
  });
  test.afterAll(async () => {
    await cleanup(f);
    await closeDb();
  });

  test("every response carries the security headers, and no server banner", async ({ request }) => {
    for (const path of ["/login", "/api/health", "/approvals"]) {
      const res = await request.get(path, { maxRedirects: 0 });
      const h = res.headers();
      expect(h["x-content-type-options"], path).toBe("nosniff");
      expect(h["x-frame-options"], path).toBe("DENY");
      expect(h["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
      expect(h["permissions-policy"], path).toContain("camera=()");
      expect(h["cross-origin-opener-policy"], path).toBe("same-origin");
      expect(h["x-powered-by"], path).toBeUndefined();
    }
    const csp = (await request.get("/login")).headers()["content-security-policy"]!;
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  test("each request gets its own nonce, and the page's scripts carry it", async ({ page, request }) => {
    const a = (await request.get("/login")).headers()["content-security-policy"]!;
    const b = (await request.get("/login")).headers()["content-security-policy"]!;
    expect(a).not.toBe(b);
    const response = await page.goto("/login");
    const nonce = /'nonce-([^']+)'/.exec(response!.headers()["content-security-policy"]!)![1]!;
    const scripts = await page.locator("script[nonce]").evaluateAll((els) => els.map((e) => (e as HTMLScriptElement).nonce));
    expect(scripts.length).toBeGreaterThan(0);
    expect(new Set(scripts)).toEqual(new Set([nonce]));
  });

  test("the whole signed-in app runs under the policy with nothing blocked and no script errors", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.name}`));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        ((window as unknown as { __csp: string[] }).__csp ??= []).push(`${e.violatedDirective} :: ${e.blockedURI.slice(0, 80)} :: ${(e.sample || "").slice(0, 60)}`);
      });
    });
    await signIn(page, f.emails.admin);
    for (const path of PAGES) {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      const violations = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
      expect(violations, path).toEqual([]);
    }
    expect(problems).toEqual([]);
  });

  test("hostile markup in a title is shown as text and never runs", async ({ page }) => {
    await signIn(page, f.emails.admin);
    for (const path of ["/items", `/items/${itemId}`, "/approvals"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), path).toBeUndefined();
      expect(await page.locator("img[src='x']").count(), path).toBe(0); // it was never turned into an element
    }
    await page.goto("/items");
    await expect(page.getByText("<img src=x", { exact: false }).first()).toBeVisible(); // the characters themselves are what is displayed
  });
});
