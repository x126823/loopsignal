import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Load .env for local runs. CI provides these variables directly. Done here so the browser tests (which talk to the database
// to set up and check data) and the dev server see the same configuration.
if (existsSync(".env")) process.loadEnvFile(".env");

// Gmail is a feature flag, off by default. The browser tests turn it on against a fake Google (e2e/fake-google-server.ts), never the
// real one: the OAuth endpoints, the Gmail API and the signing keys all point at it, and the client id and secret are made up.
// Set here, so the dev server, the fixture CLI and the test workers all see the same values.
export const FAKE_GOOGLE_PORT = 4010;
Object.assign(process.env, {
  GMAIL_ENABLED: "true",
  GOOGLE_OAUTH_CLIENT_ID: "fake-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "fake-client-secret",
  GOOGLE_TEST_BASE_URL: `http://127.0.0.1:${FAKE_GOOGLE_PORT}`,
  FAKE_GOOGLE_PORT: String(FAKE_GOOGLE_PORT),
  APP_BASE_URL: "http://localhost:3000",
  GMAIL_PUBSUB_TOPIC: "",
});

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure" },
  webServer: [
    {
      command: "node --import tsx e2e/fake-google-server.ts",
      url: `http://127.0.0.1:${FAKE_GOOGLE_PORT}/__control/health`,
      reuseExistingServer: !process.env["CI"],
      timeout: 60_000,
    },
    {
      command: "npm run dev",
      url: "http://localhost:3000/api/health",
      reuseExistingServer: !process.env["CI"],
      timeout: 120_000,
    },
  ],
});
