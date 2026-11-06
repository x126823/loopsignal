import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../../generated/prisma/client";
import { getEnv } from "../env";
import { createPrismaClient } from "./client";

/**
 * Tenant-scoped data layer.
 *
 * Every query runs inside `withTenant`, which (1) opens a transaction and sets the transaction-local
 * Postgres settings that RLS policies read, and (2) activates the Prisma extension below, which injects
 * `organizationId` into reads and writes. Both layers fail closed: with no context the extension throws
 * and RLS returns no rows. Raw SQL is only available through the transaction client, so RLS still applies.
 */
export interface TenantContext {
  /** Active organization (tenant scope). */
  organizationId?: string;
  /** Authenticated user (own-row access, membership lookup, org switcher). */
  userId?: string;
  /** Email being authenticated (sign-in lookup only). */
  loginEmail?: string;
}

const contextSchema = z
  .object({
    organizationId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    loginEmail: z.string().email().optional(),
  })
  .strict()
  .refine((c) => c.organizationId || c.userId || c.loginEmail, { message: "empty tenant context" });

/**
 * The active tenant context. It lives on globalThis, like the client below, because Next.js can load this module more than
 * once (separately bundled routes and server actions each get their own copy). The scoped client is shared across copies, so
 * the store it reads must be shared too; a module-local store would be empty whenever a different copy ran `withTenant`.
 */
const globalForStore = globalThis as unknown as { __loopsignalTenantStore?: AsyncLocalStorage<TenantContext> };
const store = (globalForStore.__loopsignalTenantStore ??= new AsyncLocalStorage<TenantContext>());

/** Models with a direct organizationId column. Everything here is scoped by the extension. */
const ORG_SCOPED_MODELS = new Set([
  "Membership", "Team", "TeamMember",
  "SourceConnection", "MonitoredSource", "RawEvent", "Thread", "Participant", "Message", "TrackedItem",
  "ItemMessageLink", "LifecycleEvent", "ItemOwnership", "ApprovalRequest", "CorrelationCandidate", "ReviewTask",
  "AnalysisRun", "BusinessCalendar", "SlaPolicy", "SlaTimer", "SlaBreach", "Notification",
  "NotificationPreference", "AuditLog", "MetricSnapshot", "ConnectionCredential",
]);

/** Append-only tables (triggers and grants enforce this too; rejecting here gives a clear error first). */
const APPEND_ONLY_MODELS = new Set(["RawEvent", "LifecycleEvent", "AuditLog"]);
const MUTATING_OPS = new Set(["update", "updateMany", "upsert", "delete", "deleteMany"]);

const WHERE_OPS = new Set([
  "findMany", "findFirst", "findFirstOrThrow", "count", "aggregate", "groupBy", "updateMany", "deleteMany",
]);
const UNIQUE_OPS = new Set(["findUnique", "findUniqueOrThrow", "update", "delete"]);

type Args = Record<string, unknown>;

function assertSameOrg(value: unknown, organizationId: string): void {
  if (value !== undefined && value !== organizationId) {
    throw new Error("Cross-tenant write rejected: organizationId does not match tenant context");
  }
}

function scopeData(data: unknown, organizationId: string): unknown {
  const row = { ...(data as Args) };
  if ("organization" in row) throw new Error("Relation-style organization writes are not allowed; use tenant context");
  assertSameOrg(row["organizationId"], organizationId);
  return { ...row, organizationId };
}

function scopeArgs(operation: string, args: Args, organizationId: string): Args {
  const next: Args = { ...args };
  if (WHERE_OPS.has(operation)) {
    next["where"] = { AND: [(args["where"] as object | undefined) ?? {}, { organizationId }] };
    if (operation === "updateMany" && args["data"]) {
      assertSameOrg((args["data"] as Args)["organizationId"], organizationId);
    }
  } else if (UNIQUE_OPS.has(operation)) {
    assertSameOrg((args["where"] as Args | undefined)?.["organizationId"], organizationId);
    next["where"] = { ...(args["where"] as object), organizationId };
    if (operation === "update" && args["data"]) {
      assertSameOrg((args["data"] as Args)["organizationId"], organizationId);
    }
  } else if (operation === "create") {
    next["data"] = scopeData(args["data"], organizationId);
  } else if (operation === "createMany" || operation === "createManyAndReturn") {
    const data = args["data"];
    next["data"] = Array.isArray(data)
      ? data.map((d) => scopeData(d, organizationId))
      : scopeData(data, organizationId);
  } else if (operation === "upsert") {
    assertSameOrg((args["where"] as Args | undefined)?.["organizationId"], organizationId);
    next["where"] = { ...(args["where"] as object), organizationId };
    next["create"] = scopeData(args["create"], organizationId);
    assertSameOrg((args["update"] as Args | undefined)?.["organizationId"], organizationId);
  } else {
    // Unknown operation on a scoped model: refuse rather than guess.
    throw new Error(`Operation ${operation} is not permitted on tenant-scoped models`);
  }
  return next;
}

function createScopedClient(base: PrismaClient) {
  return base.$extends(
    Prisma.defineExtension({
      name: "tenant-scope",
      query: {
        $allModels: {
          $allOperations({ model, operation, args, query }) {
            const ctx = store.getStore();
            if (!ctx) throw new Error("Database access outside a tenant context (use withTenant)");
            if (!ORG_SCOPED_MODELS.has(model)) return query(args); // Organization, User: RLS enforces
            if (APPEND_ONLY_MODELS.has(model) && MUTATING_OPS.has(operation)) {
              throw new Error(`${model} is append-only: ${operation} is not permitted`);
            }
            if (!ctx.organizationId) {
              // Without an org, only the user's own memberships may be read (RLS enforces userId match).
              if (model === "Membership" && ctx.userId && WHERE_OPS.has(operation)) return query(args);
              throw new Error(`${model} access requires organizationId in tenant context`);
            }
            return query(scopeArgs(operation, args as Args, ctx.organizationId) as typeof args);
          },
        },
      },
    }),
  );
}

type ScopedClient = ReturnType<typeof createScopedClient>;
export type TenantTx = Omit<ScopedClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

const globalForDb = globalThis as unknown as { __loopsignalScoped?: ScopedClient };

function getScopedClient(): ScopedClient {
  globalForDb.__loopsignalScoped ??= createScopedClient(createPrismaClient(getEnv().APP_DATABASE_URL));
  return globalForDb.__loopsignalScoped;
}

/** Run `fn` inside a transaction bound to the given tenant context. `timeoutMs` raises Prisma's 5s default for bulk work. */
export async function withTenant<T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
  const parsed = contextSchema.parse(ctx);
  return getScopedClient().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT
      set_config('app.org_id', ${parsed.organizationId ?? ""}, true),
      set_config('app.user_id', ${parsed.userId ?? ""}, true),
      set_config('app.login_email', ${parsed.loginEmail ?? ""}, true)`;
    // Await inside the run: Prisma promises are lazy and would otherwise execute outside the context.
    return store.run(parsed, async () => await fn(tx as unknown as TenantTx));
  }, { timeout: opts.timeoutMs ?? 5_000 });
}

/** Exposed for tests that need to prove the extension is the only thing between callers and the DB. */
export const __internal = { createScopedClient, store };

/**
 * Ids of the organizations that have SLA policies, for the breach scanner. This is the single deliberate cross-tenant read in
 * the application: a narrow SECURITY DEFINER function (see the sla_engine migration) returning ids only. Raw SQL is not seen by
 * the tenant extension, so this works without a tenant context; callers then process each organization under its own context.
 */
export async function listOrganizationsWithSlaPolicies(): Promise<string[]> {
  const rows = await getScopedClient().$queryRaw<Array<{ id: string }>>`SELECT sla_scan_org_ids() AS id`;
  return rows.map((r) => r.id);
}

/** Organizations with an active Gmail connection, for the poll and watch-renewal scan. Same pattern as above: ids only. */
export async function listOrganizationsWithGmail(): Promise<string[]> {
  const rows = await getScopedClient().$queryRaw<Array<{ id: string }>>`SELECT gmail_scan_org_ids() AS id`;
  return rows.map((r) => r.id);
}

/**
 * The enabled mailbox sources that watch an address, for the Pub/Sub push endpoint (a notification names a mailbox, never an
 * organization). Returns ids only; the caller then enqueues a sync job for each, which runs under that organization's context.
 */
export async function findGmailMailboxSources(address: string): Promise<Array<{ organizationId: string; monitoredSourceId: string }>> {
  return getScopedClient().$queryRaw<Array<{ organizationId: string; monitoredSourceId: string }>>`SELECT * FROM gmail_mailbox_sources(${address})`;
}
