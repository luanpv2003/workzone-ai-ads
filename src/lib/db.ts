import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

/** Read a large result in pages of ≤500 rows and concatenate them, so one query never loads thousands of parents with their nested relations. `page` must have a stable orderBy (including id). */
export async function findPaged<T>(page: (skip: number, take: number) => Promise<T[]>, limit = Infinity, size = 500): Promise<T[]> {
  const out: T[] = [];
  while (out.length < limit) {
    const take = Math.min(size, limit - out.length);
    const rows = await page(out.length, take);
    out.push(...rows);
    if (rows.length < take) break;
  }
  return out;
}

/** The database did not answer in time (Prisma P1008, "Socket timeout"): worth retrying. */
export function isDbBusy(err: unknown) {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === "P1008" || /Socket timeout/i.test(e?.message ?? "");
}

/** Short, retryable write (not inside a transaction): if the DB is busy, wait and retry, at most `tries` times. */
export async function retryBusy<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries || !isDbBusy(err)) throw err;
      await new Promise((r) => setTimeout(r, 2_000 * i));
    }
  }
}
