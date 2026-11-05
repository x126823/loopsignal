import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Load .env for local runs. CI provides these variables directly. Done here so the browser tests (which talk to the database
// to set up and check data) and the dev server see the same configuration.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure" },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/api/health",
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
});
