import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * docker-compose.real.yml runs with REAL data. Three things must stay true, so they are checked on every build: nothing is reachable from the
 * network, no password is written in the file, and nothing shares a name with the development stack's data.
 */
const compose = readFileSync("docker-compose.real.yml", "utf8");
const init = readFileSync("docker/postgres-real/init/01-roles.sh", "utf8");
const code = compose.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

describe("docker-compose.real.yml", () => {
  it("binds every published port to 127.0.0.1 only", () => {
    const lines = code.split("\n");
    const ports = lines.flatMap((l, i) => (/^\s+ports:\s*$/.test(l) ? lines.slice(i + 1).filter((x, j, rest) => rest.slice(0, j + 1).every((y) => /^\s+- /.test(y))) : [])).map((l) => /"([^"]+)"/.exec(l)?.[1] ?? l);
    expect(ports.length).toBeGreaterThanOrEqual(2);
    for (const p of ports) expect(p, p).toMatch(/^127\.0\.0\.1:/);
    expect(code).not.toMatch(/^\s+- "?\d+:\d+"?\s*$/m); // no bare host:container mapping, which would listen on every interface
    expect(code).not.toMatch(/0\.0\.0\.0/);
  });

  it("takes every secret from the environment, requiring it, and writes none in the file", () => {
    for (const name of ["POSTGRES_USER", "POSTGRES_PASSWORD", "APP_DB_PASSWORD", "REDIS_PASSWORD"]) expect(code, name).toMatch(new RegExp(`\\$\\{${name}:\\?`));
    for (const l of code.split("\n")) expect(l, l).not.toMatch(/^\s*[A-Z_]*PASSWORD:\s+(?!\$\{)["']?\S/); // a password KEY always takes its value from ${...}
    expect(code).not.toMatch(/loopsignal_app/); // the application role (and its password) are created by the init script, from the environment
    expect(code).not.toMatch(/PASSWORD: ["']?(loopsignal|password|secret|changeme)/i);
  });

  it("protects Redis with a password", () => {
    expect(code).toMatch(/--requirepass/);
  });

  it("keeps its own project name and volumes, apart from the development stack", () => {
    expect(code).toMatch(/^name: loopsignal-real$/m);
    const dev = readFileSync("docker-compose.yml", "utf8");
    expect(dev).not.toMatch(/loopsignal-real/);
    expect(code).toMatch(/^volumes:\n\s+pgdata:\n\s+redisdata:/m);
  });

  it("creates the application role without a password in the file, and without any privilege to bypass row-level security", () => {
    expect(init).toMatch(/PASSWORD :'app_pw'/); // a psql variable, filled from APP_DB_PASSWORD
    expect(init).not.toMatch(/PASSWORD '[^']/);
    expect(init).toMatch(/NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS/);
    expect(statSync("docker/postgres-real/init/01-roles.sh").mode & 0o100).toBeGreaterThan(0); // executable
  });
});
