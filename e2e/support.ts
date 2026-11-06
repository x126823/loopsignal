import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import type { Page } from "@playwright/test";

/**
 * Browser-test helpers. Fixtures are created in a child process (e2e/fixture-cli.ts) through the real lifecycle engine, so
 * this Playwright process stays light; assertions read the database directly with plain SQL as the owner role.
 */
export interface Fx {
  organizationId: string;
  teamId: string;
  users: Record<"admin" | "lead" | "member" | "viewer" | "auditor" | "otherTeamMember", string>;
  emails: Record<"admin" | "lead" | "member" | "viewer" | "auditor" | "otherTeamMember", string>;
}

function cli<T>(command: string, args: unknown = {}): T {
  const out = execFileSync(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "e2e/fixture-cli.ts", command, JSON.stringify(args)], {
    encoding: "utf8", env: process.env, maxBuffer: 10 * 1024 * 1024,
  });
  const line = out.split("\n").find((l) => l.startsWith("@@JSON@@"));
  if (!line) throw new Error(`fixture-cli printed no result for ${command}`);
  return JSON.parse(line.slice("@@JSON@@".length)) as T;
}

// One worker runs every spec file in the same module instance, so the pool is opened on demand and a spec's afterAll can close
// it without breaking the next spec file.
let sharedPool: Pool | null = null;
const getPool = (): Pool => (sharedPool ??= new Pool({ connectionString: process.env["DATABASE_URL"]!.replace(/\?schema=\w+$/, "") }));
export async function closeDb(): Promise<void> {
  const p = sharedPool;
  sharedPool = null;
  await p?.end();
}
export async function sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(text, params)).rows as T[];
}

export const newOrg = () => cli<Fx>("new-org");
export const newItem = (org: Fx, title: string, opts: { state?: "RECEIVED" | "RESPONDED" | "RESOLUTION_PROPOSED"; suggestConfirmation?: boolean } = {}) =>
  cli<{ itemId: string; threadId: string }>("new-item", { org, title, ...opts });
export const newSlaItem = (org: Fx, title: string, opts: { replied?: boolean } = {}) => cli<{ itemId: string; threadId: string }>("new-sla-item", { org, title, ...opts });
export const newCandidate = (org: Fx) => cli<{ itemId: string; candidateId: string; chatThreadId: string; chatMessageId: string }>("new-candidate", { org });
export const notify = (org: Fx, itemId: string, type: "sla_breach" | "review_ownership", who: keyof Fx["users"]) => cli<{ inApp: number; email: number }>("notify", { org, itemId, type, who });
export const humanMove = (org: Fx, itemId: string, to: "RESOLUTION_CONFIRMED" | "CLOSED") => cli("human-move", { org, itemId, to });
export const queueReview = (org: Fx, type: "OWNERSHIP" | "LOW_CONFIDENCE", itemId: string) => cli("queue-review", { org, type, itemId });
export const gmailSync = (organizationId: string, monitoredSourceId: string, analyze = true) =>
  cli<{ summary: { status: string; reason?: string; messagesCreated: number; messagesExisting: number }; statuses: string[]; reasons: string[] }>("gmail-sync", { organizationId, monitoredSourceId, analyze });

/** Steer the fake Google (a separate process): who the next consent grants, mail arriving, access being revoked. */
export async function fakeGoogle(path: "consent" | "add-message" | "expire-history" | "revoke-refresh" | "expire-access" | "state" | "chat-add-message" | "chat-membership" | "chat-status", body: unknown = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${process.env["FAKE_GOOGLE_PORT"] ?? 4010}/__control/${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`fake google ${path} failed: ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}
export const retentionDemo = (org: Fx, ageDays: number) => cli<{ rawEvents: number; messages: number }>("retention-demo", { org, ageDays });
export const auditVerify = () => cli<{ organizations: number; broken: number }>("audit-verify");
export const cleanup = (...orgs: Fx[]) => cli("cleanup", { orgs });

export const stateOf = async (itemId: string) => (await sql<{ state: string }>(`select state from "TrackedItem" where id = $1`, [itemId]))[0]!.state;
export const decisionEvents = (itemId: string) =>
  sql<{ toState: string; actorType: string; actorId: string | null; reason: string | null }>(
    `select "toState", "actorType", "actorId", reason from "LifecycleEvent" where "itemId" = $1 and "toState" in ('RESOLUTION_CONFIRMED','CLOSED','REOPENED') order by seq`, [itemId]);
export const setOrgSettings = (organizationId: string, settings: object) => sql(`update "Organization" set settings = $2::jsonb where id = $1`, [organizationId, JSON.stringify(settings)]);

/** Simulate someone else changing the item while a form is open, by bumping its version the way the engine would. */
export async function bumpVersion(itemId: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.lifecycle_writer', 'on', true)`);
    await client.query(`update "TrackedItem" set version = version + 1 where id = $1`, [itemId]);
    await client.query("commit");
  } finally {
    client.release();
  }
}

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/approvals/);
}
