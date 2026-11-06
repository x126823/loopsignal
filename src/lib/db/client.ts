import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../generated/prisma/client";

/** Build a raw PrismaClient. Application code must not use this directly; use `withTenant`. */
export function createPrismaClient(connectionString: string, opts: { poolMax?: number } = {}): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, ...(opts.poolMax ? { max: opts.poolMax } : {}) }) });
}
