import { expect, test, type APIRequestContext } from "@playwright/test";

// Requires seeded synthetic users (npm run db:seed) and AUTH_DEV_LOGIN=true.
async function devLogin(request: APIRequestContext, email: string) {
  const { csrfToken } = await (await request.get("/api/auth/csrf")).json();
  await request.post("/api/auth/callback/dev", { form: { csrfToken, email, json: "true" } });
  return (await (await request.get("/api/auth/session")).json()) as { user?: { id?: string; email?: string } } | null;
}

test("dev provider is offered", async ({ request }) => {
  const providers = await (await request.get("/api/auth/providers")).json();
  expect(Object.keys(providers)).toContain("dev");
});

test("a seeded synthetic user can sign in and gets their database id", async ({ request }) => {
  const session = await devLogin(request, "alice@synthetic.loopsignal.test");
  expect(session?.user?.email).toBe("alice@synthetic.loopsignal.test");
  expect(session?.user?.id).toBe("00000000-0000-4000-8000-000000000011");
});

test("an unknown synthetic email cannot sign in (invite-only)", async ({ request }) => {
  const session = await devLogin(request, "nobody@synthetic.loopsignal.test");
  expect(session?.user).toBeUndefined();
});

test("a non-synthetic email cannot use dev login", async ({ request }) => {
  const session = await devLogin(request, "alice@example.com");
  expect(session?.user).toBeUndefined();
});
