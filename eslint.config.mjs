import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import boundaries from "eslint-plugin-boundaries";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "node_modules/**", "generated/**", "coverage/**", "playwright-report/**", "next-env.d.ts"]),
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { boundaries },
    settings: {
      "import/resolver": { typescript: { project: "./tsconfig.json" } },
      "boundaries/elements": [
        { type: "module", pattern: "src/modules/*", capture: ["name"] },
        { type: "worker", pattern: "src/workers" },
        { type: "app", pattern: "src/app" },
        { type: "shared", pattern: ["src/lib", "src/components"] },
      ],
    },
    rules: {
      // One rule enforces the architecture (default deny):
      //  - cross-module imports go through src/modules/<name>/index.ts only
      //  - modules never import workers or app (workers call modules, not the reverse)
      //  - shared code (lib, components, env) never depends on modules, workers or app
      "boundaries/dependencies": [
        2,
        {
          default: "disallow",
          policies: [
            { allow: { to: { module: { origin: ["external", "core"] } } } },
            { allow: { to: { element: { type: "shared" } } } },
            { from: { element: { type: "app" } }, allow: { to: { element: { type: "app" } } } },
            { from: { element: { type: "worker" } }, allow: { to: { element: { type: "worker" } } } },
            {
              from: { element: { type: ["app", "worker", "module"] } },
              allow: { to: { element: { type: "module" }, file: { path: "src/modules/*/index.ts" } } },
            },
            {
              from: { element: { type: "module" } },
              allow: { to: { element: { type: "module", captured: { name: "{{ from.element.captured.name }}" } } } },
            },
          ],
        },
      ],
    },
  },
]);
