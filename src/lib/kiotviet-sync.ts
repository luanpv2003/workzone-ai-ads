import { db, isDbBusy, retryBusy } from "./db";
import { normalizePhone } from "./pii";
import { getT } from "@/i18n/server";
import { invoiceCounts, kiotCreds, kiotGet, kiotPaged, kvDate, vnDay, type KiotCreds, type KvBranchRow, type KvCustomerRow, type KvInvoiceRow } from "./kiotviet";

// Sync KiotViet → DB for 1 client (read-only). The worker (scripts/targeting-worker.ts) calls it every minute for the client whose turn it is:
// 1. Branches.
// 2. Customers: read everything the first time (with per-page checkpoints), then only customers modified since the last mark.
// 3. Recent invoices: re-read the last 3 days (catching late edits / cancellations) + days missed while the worker was down.
// 4. Backfill history day by day (newest → oldest) up to kiotMonths months; each run takes at most budgetMs then yields to other clients, continuing next run.
// Per invoice day: delete then rewrite KvDaily (day × branch), KvProductDaily (day × product, kept 120 days), KvInvoice (invoices tied to a customer).

type KiotState = {
  customersFull?: boolean; // finished the initial full read of customers
  customersAt?: number; // position checkpoint during the initial read
  customersCursor?: string; // ISO: next time read customers modified since this mark
  target?: string; // oldest day to pull (YYYY-MM-DD)
  oldest?: string; // oldest day fully pulled (continuous backfill from today)
  recentTo?: string; // newest day fully pulled
  phase?: string; // what it's doing (shown on the web)
  failedAt?: string; // most recent error (wait 15 minutes before retrying)
  runStartedAt?: string;
};

const RECENT_DAYS = 3;
const PRODUCT_KEEP_DAYS = 120;
const RESYNC_MS = 2 * 3600_000; // auto-sync every 2 hours

export const parseKiotState = (s: string | null | undefined): KiotState => {
  try {
    return JSON.parse(s || "{}") as KiotState;
  } catch {
    return {};
  }
};

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const today = () => vnDay(new Date());
/** VN time in the format KiotViet accepts (no timezone). */
const kvParam = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 19);

/** History days still to pull / total (for the progress bar). */
export function backfillProgress(st: KiotState, months: number) {
  const target = st.target ?? addDays(today(), -months * 30);
  const total = Math.max(1, Math.round((Date.parse(today()) - Date.parse(target)) / 86400_000) + 1);
  const done = st.oldest ? Math.round((Date.parse(today()) - Date.parse(st.oldest)) / 86400_000) + 1 : 0;
  return { done: Math.min(done, total), total, complete: !!st.oldest && st.oldest <= target };
}

/** Syncing: heartbeat within the last 5 minutes. */
export const kiotRunning = (c: { kiotRunningAt: Date | null }) => !!c.kiotRunningAt && Date.now() - c.kiotRunningAt.getTime() < 5 * 60_000;

/** Due for sync: the user just clicked, history isn't fully pulled, or over 2 hours have passed. */
export function kiotDue(c: { kiotSecret: string | null; kiotState: string; kiotMonths: number; kiotSyncAt: Date | null; kiotRequestAt: Date | null; kiotSyncError: string | null }) {
  if (!c.kiotSecret) return false;
  if (c.kiotRequestAt && (!c.kiotSyncAt || c.kiotRequestAt > c.kiotSyncAt)) return true;
  const last = c.kiotSyncAt?.getTime() ?? 0;
  const st = parseKiotState(c.kiotState);
  // On error wait 15 minutes before retrying (avoid piling calls when credentials are wrong / KiotViet is under maintenance).
  if (c.kiotSyncError) return Date.now() - Date.parse(st.failedAt ?? "1970-01-01") > 15 * 60_000;
  if (!st.customersFull || !backfillProgress(st, c.kiotMonths).complete) return true;
  return Date.now() - last > RESYNC_MS;
}

function phoneOf(raw: string | null | undefined) {
  if (!raw) return null;
  for (const part of [raw, ...raw.split(/[,;/|\n]+/)]) {
    const p = normalizePhone(part.trim());
    if (p) return p;
  }
  return null;
}

function customerData(r: KvCustomerRow) {
  return {
    code: r.code ?? "",
    name: r.name ?? "",
    phone: phoneOf(r.contactNumber),
    gender: r.gender == null ? null : r.gender ? "nam" : "nu",
    birthDate: r.birthDate ? r.birthDate.slice(0, 10) : null,
    area: r.locationName ?? "",
    ward: r.wardName ?? "",
    totalRevenue: Number(r.totalRevenue ?? 0),
    totalInvoiced: Number(r.totalInvoiced ?? 0),
    createdDate: kvDate(r.createdDate),
    modifiedDate: kvDate(r.modifiedDate),
  };
}

async function saveCustomers(clientId: string, rows: KvCustomerRow[]) {
  if (!rows.length) return;
  // Delete then rewrite the whole page (2 statements) instead of 100 upserts: fewer round trips, shorter transaction.
  const data = [...new Map(rows.map((r) => [String(r.id), r])).entries()].map(([kvId, r]) => ({ clientId, kvId, ...customerData(r) }));
  await retryBusy(() =>
    db.$transaction([db.kvCustomer.deleteMany({ where: { clientId, kvId: { in: data.map((d) => d.kvId) } } }), db.kvCustomer.createMany({ data })]),
  );
}

/** Read all invoices of 1 day then rewrite the day totals, products, and invoices with customers. */
async function pullDay(c: KiotCreds, clientId: string, day: string, shouldStop?: () => boolean) {
  const byId = new Map<string, KvInvoiceRow>();
  await kiotPaged<KvInvoiceRow>(
    c,
    "/invoices",
    { fromPurchaseDate: `${day}T00:00:00`, toPurchaseDate: `${day}T23:59:59` },
    async (rows) => {
      for (const r of rows) byId.set(String(r.id), r);
    },
    { throttle: true, shouldStop },
  );

  const daily = new Map<number, { invoices: number; revenue: number; withCustomer: number }>();
  const products = new Map<string, { code: string; name: string; qty: number; revenue: number }>();
  const invoices: { clientId: string; kvId: string; code: string; purchaseDate: Date; date: string; branchId: number; customerId: string; total: number; status: number }[] = [];
  let counted = 0;
  for (const [kvId, r] of byId) {
    const at = kvDate(r.purchaseDate);
    if (!at || vnDay(at) !== day || !invoiceCounts(r.status)) continue;
    counted++;
    const total = Number(r.total ?? 0);
    const customerId = r.customerId ? String(r.customerId) : null;
    const d = daily.get(r.branchId) ?? { invoices: 0, revenue: 0, withCustomer: 0 };
    d.invoices++;
    d.revenue += total;
    if (customerId) d.withCustomer++;
    daily.set(r.branchId, d);
    for (const l of r.invoiceDetails ?? []) {
      const pid = String(l.productId);
      const p = products.get(pid) ?? { code: l.productCode ?? "", name: l.productName ?? "", qty: 0, revenue: 0 };
      const qty = Number(l.quantity ?? 0);
      p.qty += qty;
      // price is the pre-discount price, discount is the discount per unit (cross-checked against real invoice totals 28/10).
      p.revenue += qty * (Number(l.price ?? 0) - Number(l.discount ?? 0));
      products.set(pid, p);
    }
    if (customerId) invoices.push({ clientId, kvId, code: r.code ?? "", purchaseDate: at, date: day, branchId: r.branchId, customerId, total, status: r.status ?? 1 });
  }

  const keepProducts = day >= addDays(today(), -PRODUCT_KEEP_DAYS);
  const ids = invoices.map((i) => i.kvId);
  const chunks = Array.from({ length: Math.ceil(ids.length / 500) }, (_, i) => ids.slice(i * 500, i * 500 + 500));
  await retryBusy(() => db.$transaction([
    db.kvDaily.deleteMany({ where: { clientId, date: day } }),
    db.kvProductDaily.deleteMany({ where: { clientId, date: day } }),
    db.kvInvoice.deleteMany({ where: { clientId, date: day } }),
    // An invoice whose purchase date changed (edited in KiotViet) still keeps just 1 copy. Batched to keep each statement small.
    ...chunks.map((part) => db.kvInvoice.deleteMany({ where: { clientId, kvId: { in: part } } })),
    db.kvDaily.createMany({ data: [...daily].map(([branchId, v]) => ({ clientId, date: day, branchId, ...v })) }),
    db.kvProductDaily.createMany({ data: keepProducts ? [...products].map(([productId, v]) => ({ clientId, date: day, productId, ...v })) : [] }),
    db.kvInvoice.createMany({ data: invoices }),
  ]));
  return counted;
}

type KiotSyncResult = { customers: number; days: number; invoices: number; complete: boolean };

/**
 * One sync run. budgetMs: when time runs out stop at a day boundary (already saved); the next run continues.
 * shouldStop: the worker is shutting down.
 */
export async function syncKiot(clientId: string, opts: { budgetMs?: number; shouldStop?: () => boolean } = {}): Promise<KiotSyncResult> {
  const t = await getT();
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  const c = kiotCreds(client);
  if (!c) throw new Error(t("settings.kiotSync.notConnected"));
  const started = Date.now();
  const deadline = started + (opts.budgetMs ?? 15 * 60_000);
  const outOfTime = () => Date.now() > deadline || !!opts.shouldStop?.();
  let st: KiotState = { ...parseKiotState(client.kiotState), runStartedAt: new Date(started).toISOString() };
  const save = async (patch: Partial<KiotState>, extra: Record<string, unknown> = {}) => {
    st = { ...st, ...patch };
    const data = { kiotState: JSON.stringify(st), kiotRunningAt: new Date(), ...extra };
    await retryBusy(() => db.client.update({ where: { id: clientId }, data }));
  };
  const res: KiotSyncResult = { customers: 0, days: 0, invoices: 0, complete: false };

  try {
    await save({ phase: t("settings.kiotSync.phaseBranches") });
    // 1. Branches
    const branches = await kiotGet<{ data?: KvBranchRow[] }>(c, "/branches", { pageSize: 100 }, { throttle: true });
    await retryBusy(() =>
      db.$transaction(
        (branches.data ?? []).map((b) =>
          db.kvBranch.upsert({
            where: { clientId_kvId: { clientId, kvId: b.id } },
            create: { clientId, kvId: b.id, name: b.branchName, address: b.address ?? "" },
            update: { name: b.branchName, address: b.address ?? "" },
          }),
        ),
      ),
    );

    // 2. Customers
    if (!st.customersFull) {
      const runAt = new Date(started - 3600_000).toISOString();
      await kiotPaged<KvCustomerRow>(
        c,
        "/customers",
        { includeTotal: true },
        async (rows, next, total) => {
          await saveCustomers(clientId, rows);
          res.customers += rows.length;
          await save({ customersAt: next, phase: t("settings.kiotSync.phaseCustomers", { done: next.toLocaleString("vi-VN"), total: total.toLocaleString("vi-VN") }) });
        },
        { throttle: true, start: st.customersAt ?? 0, shouldStop: outOfTime },
      );
      await save({ customersFull: true, customersAt: 0, customersCursor: runAt });
    } else {
      const runAt = new Date(started - 3600_000).toISOString();
      await save({ phase: t("settings.kiotSync.phaseCustomersChanged") });
      await kiotPaged<KvCustomerRow>(
        c,
        "/customers",
        { includeTotal: true, lastModifiedFrom: st.customersCursor ? kvParam(new Date(st.customersCursor)) : undefined },
        async (rows) => {
          await saveCustomers(clientId, rows);
          res.customers += rows.length;
        },
        { throttle: true, shouldStop: opts.shouldStop },
      );
      await save({ customersCursor: runAt });
    }

    // 3. Recent invoices (including missed days, at most up to the backfill mark)
    const now = today();
    const target = st.target ?? addDays(now, -client.kiotMonths * 30);
    if (!st.target) await save({ target });
    let from = addDays(now, -(RECENT_DAYS - 1));
    if (st.recentTo && st.recentTo < from) from = addDays(st.recentTo, -1);
    if (st.oldest && from < st.oldest) from = st.oldest;
    for (let day = now; day >= from; day = addDays(day, -1)) {
      await save({ phase: t("settings.kiotSync.phaseInvoices", { day }) });
      res.invoices += await pullDay(c, clientId, day, opts.shouldStop);
      res.days++;
    }
    await save({ recentTo: now, oldest: st.oldest && st.oldest < from ? st.oldest : from });

    // 4. Backfill history
    while (st.oldest! > target && !outOfTime()) {
      const day = addDays(st.oldest!, -1);
      await save({ phase: t("settings.kiotSync.phaseHistory", { day }) });
      res.invoices += await pullDay(c, clientId, day, outOfTime);
      res.days++;
      await save({ oldest: day });
    }

    await retryBusy(() => db.kvProductDaily.deleteMany({ where: { clientId, date: { lt: addDays(now, -PRODUCT_KEEP_DAYS) } } }));
    res.complete = backfillProgress(st, client.kiotMonths).complete;
    await save({ phase: undefined }, { kiotSyncAt: new Date(), kiotSyncError: null, kiotRunningAt: null });
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Stopped because the run's time is up / worker shutting down, or the DB is busy (another job holds the write lock): not an error; the next run (~1 minute) continues from the checkpoint.
    const paused = outOfTime() || isDbBusy(err);
    const data = {
      kiotState: JSON.stringify({ ...st, phase: undefined, ...(!paused && { failedAt: new Date().toISOString() }) }),
      kiotRunningAt: null,
      ...(paused ? { kiotSyncAt: new Date(), kiotSyncError: null } : { kiotSyncError: msg.slice(0, 500), kiotRequestAt: null }),
    };
    await retryBusy(() => db.client.update({ where: { id: clientId }, data }), 5);
    if (paused) return res;
    throw err;
  }
}

/** Delete all stored KiotViet data of the client (store changed / disconnected). */
export async function clearKiotData(clientId: string) {
  await db.$transaction([
    db.kvBranch.deleteMany({ where: { clientId } }),
    db.kvCustomer.deleteMany({ where: { clientId } }),
    db.kvInvoice.deleteMany({ where: { clientId } }),
    db.kvDaily.deleteMany({ where: { clientId } }),
    db.kvProductDaily.deleteMany({ where: { clientId } }),
  ]);
}
