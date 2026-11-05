import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => ({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // Load .env for integration tests; real env vars (CI) take precedence.
    env: { ...loadEnv(mode, process.cwd(), ""), ...process.env as Record<string, string> },
    // Integration tests share one database; run files serially.
    fileParallelism: false,
    // next-auth imports "next/server" without an extension; inline it so Vite resolves it.
    server: { deps: { inline: ["next-auth"] } },
  },
}));
