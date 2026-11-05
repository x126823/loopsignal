import { defineConfig } from "prisma/config";

// Env vars are loaded by the npm scripts via `node --env-file`; Prisma 7 does not auto-load .env.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["DATABASE_URL"] },
});
