import type { TenantTx } from "@/lib/db";

/**
 * Run `fn` with the TrackedItem lifecycle guard open (see the trackeditem_lifecycle_guard trigger). The flag is
 * transaction-local and is closed again before returning, so later writes in the same transaction are guarded.
 * Only this module may call it; ESLint bans the flag name elsewhere.
 */
export async function asLifecycleWriter<T>(tx: TenantTx, fn: () => Promise<T>): Promise<T> {
  await tx.$executeRaw`SELECT set_config('app.lifecycle_writer', 'on', true)`;
  try {
    return await fn();
  } finally {
    await tx.$executeRaw`SELECT set_config('app.lifecycle_writer', '', true)`;
  }
}
