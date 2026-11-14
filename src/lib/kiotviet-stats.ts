import { db } from "./db";
import { vnDay } from "./kiotviet";
import { getT } from "@/i18n/server";

// KiotViet sales metrics for the Sales page (and later for customer audiences / message matching).
// "Có SĐT" (Has phone) = invoices tied to a customer with a valid VN phone number: the usable part for Meta audiences, message matching and sending orders back to Meta.

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const n = (v: unknown) => Number(v ?? 0);

type PhoneRateLevel = "good" | "ok" | "low";
/** ≥50%: enough for audiences + order measurement; 30–50%: usable but incomplete; <30%: have cashiers enter phone numbers first. */
export const phoneRateLevel = (rate: number | null): PhoneRateLevel | null => (rate == null ? null : rate >= 50 ? "good" : rate >= 30 ? "ok" : "low");

export async function salesStats(clientId: string, days: number) {
  const t = await getT();
  const today = vnDay(new Date());
  const since = addDays(today, -(days - 1));

  const [branches, byBranch, phoneByBranch, byDay, phoneByDay, uniq, products] = await Promise.all([
    db.kvBranch.findMany({ where: { clientId } }),
    db.kvDaily.groupBy({ by: ["branchId"], where: { clientId, date: { gte: since } }, _sum: { invoices: true, revenue: true, withCustomer: true } }),
    db.$queryRaw<{ branchId: number; n: bigint }[]>`
      SELECT i.branchId AS branchId, COUNT(*) AS n FROM KvInvoice i
      JOIN KvCustomer c ON c.clientId = i.clientId AND c.kvId = i.customerId
      WHERE i.clientId = ${clientId} AND i.date >= ${since} AND c.phone IS NOT NULL GROUP BY i.branchId`,
    db.kvDaily.groupBy({ by: ["date"], where: { clientId, date: { gte: since } }, _sum: { invoices: true, revenue: true } }),
    db.$queryRaw<{ date: string; n: bigint }[]>`
      SELECT i.date AS date, COUNT(*) AS n FROM KvInvoice i
      JOIN KvCustomer c ON c.clientId = i.clientId AND c.kvId = i.customerId
      WHERE i.clientId = ${clientId} AND i.date >= ${since} AND c.phone IS NOT NULL GROUP BY i.date`,
    db.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(DISTINCT c.phone) AS n FROM KvInvoice i
      JOIN KvCustomer c ON c.clientId = i.clientId AND c.kvId = i.customerId
      WHERE i.clientId = ${clientId} AND i.date >= ${since} AND c.phone IS NOT NULL`,
    db.kvProductDaily.groupBy({
      by: ["productId", "code", "name"],
      where: { clientId, date: { gte: since } },
      _sum: { qty: true, revenue: true },
      orderBy: { _sum: { revenue: "desc" } },
      take: 20,
    }),
  ]);

  const names = new Map(branches.map((b) => [b.kvId, b.name]));
  const phoneB = new Map(phoneByBranch.map((r) => [n(r.branchId), n(r.n)]));
  const rows = byBranch
    .map((b) => {
      const invoices = n(b._sum.invoices);
      const withPhone = phoneB.get(b.branchId) ?? 0;
      return {
        branchId: b.branchId,
        name: names.get(b.branchId) ?? t("settings.salesPage.branchFallback", { id: b.branchId }),
        invoices,
        revenue: n(b._sum.revenue),
        withCustomer: n(b._sum.withCustomer),
        withPhone,
        phoneRate: invoices ? (withPhone / invoices) * 100 : null,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);
  const total = rows.reduce((a, r) => ({ invoices: a.invoices + r.invoices, revenue: a.revenue + r.revenue, withCustomer: a.withCustomer + r.withCustomer, withPhone: a.withPhone + r.withPhone }), {
    invoices: 0,
    revenue: 0,
    withCustomer: 0,
    withPhone: 0,
  });
  const phoneD = new Map(phoneByDay.map((r) => [r.date, n(r.n)]));
  const daily = byDay
    .map((d) => ({ date: d.date, invoices: n(d._sum.invoices), revenue: n(d._sum.revenue), withPhone: phoneD.get(d.date) ?? 0 }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    since,
    total: { ...total, phoneRate: total.invoices ? (total.withPhone / total.invoices) * 100 : null, uniquePhones: n(uniq[0]?.n) },
    branches: rows,
    daily,
    products: products.map((p) => ({ id: p.productId, code: p.code, name: p.name, qty: n(p._sum.qty), revenue: n(p._sum.revenue) })),
  };
}

/** Overview of customers with phone numbers (entire pulled history): the basis for Meta audiences in a later phase. */
export async function customerSummary(clientId: string) {
  const today = vnDay(new Date());
  const d30 = addDays(today, -29);
  const d60 = addDays(today, -59);
  const d180 = addDays(today, -179);
  const [all, withPhone, seg] = await Promise.all([
    db.kvCustomer.count({ where: { clientId } }),
    db.kvCustomer.count({ where: { clientId, phone: { not: null } } }),
    db.$queryRaw<{ buyers: bigint; active30: bigint; repeat: bigint; lapsed: bigint }[]>`
      WITH per AS (
        SELECT c.phone AS phone, COUNT(*) AS cnt, MAX(i.date) AS last FROM KvInvoice i
        JOIN KvCustomer c ON c.clientId = i.clientId AND c.kvId = i.customerId
        WHERE i.clientId = ${clientId} AND c.phone IS NOT NULL GROUP BY c.phone
      )
      SELECT COUNT(*) AS buyers,
        SUM(CASE WHEN last >= ${d30} THEN 1 ELSE 0 END) AS active30,
        SUM(CASE WHEN cnt >= 2 THEN 1 ELSE 0 END) AS repeat,
        SUM(CASE WHEN last < ${d60} AND last >= ${d180} THEN 1 ELSE 0 END) AS lapsed
      FROM per`,
  ]);
  const s = seg[0];
  return { all, withPhone, buyers: n(s?.buyers), active30: n(s?.active30), repeat: n(s?.repeat), lapsed: n(s?.lapsed) };
}
